import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { PAYOUT_RELEASE_STATUSES } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { writeAudit } from '@/lib/audit/log'
import { serverError } from '@/lib/api/errors'
import { decryptColumn, fingerprintColumn } from '@/lib/crypto'
import { bankFacts, payoutReadiness } from '@/lib/payments/readiness'

/** GET — full provider detail for ops: profile, verifications, listings, orders, earnings, reviews. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const { id } = await params
  const admin = await createAdminClient()
  const { data: provider } = await admin.from('provider_profiles').select('*').eq('id', id).maybeSingle()
  if (!provider) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [{ data: verifications }, { data: listings }, { data: orders }, { data: reviews }, { data: categories }, { data: bank }] = await Promise.all([
    admin.from('provider_verifications').select('id, kind, value, status, verified_at').eq('provider_id', id),
    admin.from('packages').select('id, slug, title_i18n, price_paise, status').eq('provider_id', id).is('deleted_at', null),
    admin.from('orders').select('id, order_number, status, total_paise, provider_earning_paise, created_at').eq('provider_id', id).order('created_at', { ascending: false }).limit(50),
    admin.from('reviews').select('id, rating, text, status, created_at').eq('provider_id', id).order('created_at', { ascending: false }).limit(20),
    admin.from('provider_categories').select('category:categories(slug, name_i18n)').eq('provider_id', id),
    // Status only — never the account number (encrypted) or IFSC.
    admin.from('provider_bank_accounts').select('penny_drop_verified, razorpay_route_account_id').eq('provider_id', id).maybeSingle(),
  ])

  const earningsPaise = (orders ?? [])
    .filter((o) => (PAYOUT_RELEASE_STATUSES as readonly string[]).includes(o.status))
    .reduce((s, o) => s + Number(o.provider_earning_paise), 0)

  // Never expose gstin/pan/bank in the API payload.
  const { gstin: _g, pan: _p, ...safeProvider } = provider as Record<string, unknown>
  void _g; void _p
  return NextResponse.json({
    provider: safeProvider,
    verifications: verifications ?? [],
    listings: listings ?? [],
    orders: orders ?? [],
    reviews: reviews ?? [],
    categories: categories ?? [],
    earningsPaise,
    // Phase 3a — readiness facts (the Route id is Razorpay's handle, not PII).
    bank: {
      ...bankFacts(bank),
      routeAccountId: bank?.razorpay_route_account_id ?? null,
      readiness: payoutReadiness(bankFacts(bank)),
    },
  })
}

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('suspend'), reason: z.string().trim().min(1).max(1000) }),
  z.object({ action: z.literal('reactivate') }),
  z.object({ action: z.literal('set_capacity_pause'), paused: z.boolean() }),
  z.object({ action: z.literal('set_badge'), kind: z.string().trim().min(1).max(40), grant: z.boolean() }),
  // Razorpay Route linked-account id (acc_...) — created in the Razorpay
  // dashboard per provider, then recorded here. Payout transfers require it;
  // without this action no production code could ever write the column.
  z.object({
    action: z.literal('set_route_account'),
    routeAccountId: z.string().trim().regex(/^acc_[A-Za-z0-9]{6,}$/, 'must be a Razorpay account id (acc_...)'),
    /** Optional note for the audit row (e.g. "linked in RZP dashboard 28 Aug"). */
    reason: z.string().trim().max(500).optional(),
  }),
  // Manual bank verification (Phase 1g). Until KYC_API_KEY is a real vendor,
  // every genuine provider lands at bank_unverified; this is the logged,
  // reason-required way to clear (or revoke) that — recorded in
  // bank_account_verifications with provider='admin_override' so it is never
  // indistinguishable from a vendor penny-drop result.
  z.object({
    action: z.literal('set_bank_verified'),
    verified: z.boolean(),
    reason: z.string().trim().min(5).max(500),
  }),
])

/** POST — ops actions: suspend/reactivate, force capacity pause, assign/revoke a verification badge. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const rl = await enforce(limiters.adminMutation, `admin:${gate.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const { id } = await params
  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const admin = await createAdminClient()
  const { data: before } = await admin.from('provider_profiles').select('status, capacity_paused, slug').eq('id', id).maybeSingle()
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const providerSlug = (before as { slug?: string }).slug

  let after: Record<string, unknown> = {}
  try {
    if (d.action === 'suspend') {
      await admin.from('provider_profiles').update({ status: 'suspended', updated_at: new Date().toISOString() }).eq('id', id)
      // §9.2 — suspended provider's scheduled payouts go on hold.
      await admin.from('payouts').update({ status: 'held' }).eq('provider_id', id).eq('status', 'scheduled')
      after = { status: 'suspended', reason: d.reason }
    } else if (d.action === 'reactivate') {
      await admin.from('provider_profiles').update({ status: 'active', updated_at: new Date().toISOString() }).eq('id', id)
      after = { status: 'active' }
    } else if (d.action === 'set_capacity_pause') {
      await admin.from('provider_profiles').update({ capacity_paused: d.paused, updated_at: new Date().toISOString() }).eq('id', id)
      after = { capacity_paused: d.paused }
    } else if (d.action === 'set_route_account') {
      // Requires an existing bank row (created at onboarding) — the Route
      // account is Razorpay's handle for that same bank account.
      const { data: bank } = await admin
        .from('provider_bank_accounts')
        .select('id')
        .eq('provider_id', id)
        .maybeSingle()
      if (!bank) {
        return NextResponse.json({ error: 'Provider has no bank account on file yet' }, { status: 409 })
      }
      await admin
        .from('provider_bank_accounts')
        .update({ razorpay_route_account_id: d.routeAccountId, updated_at: new Date().toISOString() })
        .eq('id', bank.id)
      after = { razorpay_route_account_id: d.routeAccountId, ...(d.reason ? { reason: d.reason } : {}) }
    } else if (d.action === 'set_bank_verified') {
      const { data: bank } = await admin
        .from('provider_bank_accounts')
        .select('id, account_number_enc, ifsc, account_holder, penny_drop_verified')
        .eq('provider_id', id)
        .maybeSingle()
      if (!bank) {
        return NextResponse.json({ error: 'Provider has no bank account on file yet' }, { status: 409 })
      }
      const { data: owner } = await admin.from('provider_profiles').select('user_id').eq('id', id).maybeSingle()
      // Same keyed fingerprint onboarding uses, so the override row matches the
      // account it clears (decrypt server-side; the number is never returned).
      let fingerprint: string
      try {
        fingerprint = fingerprintColumn(`${decryptColumn(bank.account_number_enc)}|${bank.ifsc}`)
      } catch (e) {
        console.error('[admin/providers set_bank_verified] cannot fingerprint bank account:', e)
        return NextResponse.json({ error: 'bank_encryption_unconfigured' }, { status: 503 })
      }
      const { error: recErr } = await admin.from('bank_account_verifications').insert({
        user_id: owner?.user_id,
        account_fingerprint: fingerprint,
        ifsc: bank.ifsc,
        account_holder: bank.account_holder,
        verified: d.verified,
        stub: false,
        provider: 'admin_override',
        result: { admin_id: gate.userId, reason: d.reason },
      })
      if (recErr) return serverError('[admin/providers set_bank_verified] record:', recErr)
      await admin
        .from('provider_bank_accounts')
        .update({ penny_drop_verified: d.verified, updated_at: new Date().toISOString() })
        .eq('id', bank.id)
      after = { penny_drop_verified: d.verified, was: bank.penny_drop_verified, method: 'admin_override', reason: d.reason }
    } else {
      // set_badge — assign (manually_approved) or revoke (rejected) a verification.
      const newStatus = d.grant ? 'manually_approved' : 'rejected'
      const { data: existing } = await admin.from('provider_verifications').select('id').eq('provider_id', id).eq('kind', d.kind).maybeSingle()
      if (existing) {
        await admin.from('provider_verifications').update({ status: newStatus, verified_by: gate.userId, verified_at: new Date().toISOString() }).eq('id', existing.id)
      } else if (d.grant) {
        await admin.from('provider_verifications').insert({ provider_id: id, kind: d.kind, value: 'admin_granted', status: newStatus, verified_by: gate.userId, verified_at: new Date().toISOString() })
      }
      after = { badge: d.kind, status: newStatus }
    }
  } catch (e) {
    return serverError('[admin/providers action]', e)
  }

  // Emergency-takedown cache-bust (Phase 8 §7): suspension must not wait out
  // ISR revalidate windows. Vercel's distributed ISR cache only honours
  // LITERAL paths (pattern-form revalidatePath purges the local route cache
  // but not the edge — verified empirically: the pattern-only version left
  // the suspended page serving for the full 5s window). So purge the exact
  // URLs: the provider page, each of its packages, and the listings that can
  // contain it — per locale ('' = default-locale as-needed prefix).
  if ((d.action === 'suspend' || d.action === 'reactivate') && providerSlug) {
    const [{ data: pkgs }, { data: cats }] = await Promise.all([
      admin.from('packages').select('slug').eq('provider_id', id).is('deleted_at', null),
      admin.from('provider_categories').select('category:categories(slug)').eq('provider_id', id),
    ])
    // '' = the public URL for the default locale; '/en' = the INTERNAL path
    // the middleware rewrites it to (as-needed prefixing) — the Data/Route
    // caches are keyed on the rewritten path, so both must be purged.
    const locales = ['', '/en', '/hi', '/te', '/ta']
    const paths: string[] = []
    for (const l of locales) {
      paths.push(`${l}/p/${providerSlug}`, `${l}/services`)
      for (const p of pkgs ?? []) paths.push(`${l}/p/${providerSlug}/${p.slug}`)
      for (const c of cats ?? []) {
        const slug = (c.category as { slug?: string } | null)?.slug
        if (slug) paths.push(`${l}/services/${slug}`)
      }
    }
    for (const p of paths) revalidatePath(p)
    // Belt-and-braces for self-hosted runtimes where patterns DO work.
    revalidatePath('/[locale]/(public)/p/[providerSlug]', 'page')
    revalidatePath('/[locale]/(public)/p/[providerSlug]/[packageSlug]', 'page')
  }

  await writeAudit(admin, request, {
    actorId: gate.userId,
    action: `provider_${d.action}`,
    entity: 'provider_profiles',
    entityId: id,
    before,
    after,
  })

  return NextResponse.json({ ok: true, ...after })
}
