import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  categoriesRequiringCredential,
  statutoryOptionsForCategory,
  CREDENTIAL_VERIFICATION_KIND,
  type CredentialOption,
} from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser, upsertUserRow } from '@/lib/auth/session'
import { encryptColumn, fingerprintColumn } from '@/lib/crypto'
import { serverError } from '@/lib/api/errors'
import { missingLegalDocs } from '@/lib/legal/acceptance'

const credentialUploadSchema = z.object({
  url: z.string().optional(),
  path: z.string().optional(),
  name: z.string().optional(),
  /** Statutory credential type (wizard option id, e.g. 'ca', 'adv'). */
  kind: z.string().max(20).optional(),
  /** Membership / enrolment / registration number for that credential. */
  number: z.string().trim().max(64).optional(),
})

const bodySchema = z.object({
  fullName: z.string().min(2).optional(),
  preferredLocale: z.enum(['en', 'hi']).default('en'),
  legalName: z.string().min(2),
  displayName: z.string().min(2),
  about: z.string().max(2000).optional(),
  yearsExperience: z.enum(['0-2', '3-9', '10+']).optional(),
  website: z.string().url().max(200).optional(),
  gstin: z.string().optional(),
  pan: z.string().optional(),
  categorySlugs: z.array(z.string()).min(1).max(5),
  state: z.string().min(2),
  city: z.string().optional(),
  languages: z.array(z.string()).default(['en']),
  bankIfsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/),
  bankAccount: z.string().min(9).max(18),
  bankHolder: z.string().min(2),
  // Accepted for wire compatibility but IGNORED — penny_drop_verified is set
  // from the server-recorded /kyc/verify-bank result (see bank section below).
  bankVerified: z.boolean().default(false),
  // Keyed by category slug → { url|path, name }
  credentialUploads: z.record(z.string(), credentialUploadSchema).default({}),
})

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const d = parsed.data

  // Signup contract (Phase 2): Terms + Privacy + Provider Addendum must be on
  // record at the current versions before a provider account is created.
  const admin = await createAdminClient()
  const missingDocs = await missingLegalDocs(admin, user.id, true)
  if (missingDocs.length > 0) {
    return NextResponse.json({ error: 'legal_acceptance_required', required: missingDocs }, { status: 403 })
  }

  // §3.3/§5 — categories that require a statutory credential must have the
  // credential type, its number, AND the document before submit
  // (defense-in-depth; the wizard also gates this).
  const missingCreds = categoriesRequiringCredential(d.categorySlugs).filter((slug) => {
    const u = d.credentialUploads[slug]
    return !u || (!u.url && !u.path) || !u.kind || !u.number
  })
  if (missingCreds.length > 0) {
    return NextResponse.json(
      { error: 'Required credential details (type, number, document) are missing for your selected categories', missing: missingCreds },
      { status: 422 },
    )
  }
  // A claimed credential type must be one this category actually accepts.
  const invalidKind = Object.entries(d.credentialUploads).find(
    ([slug, u]) => u.kind && !(statutoryOptionsForCategory(slug) as readonly string[]).includes(u.kind),
  )
  if (invalidKind) {
    return NextResponse.json(
      { error: `Credential type "${invalidKind[1].kind}" is not accepted for category "${invalidKind[0]}"` },
      { status: 422 },
    )
  }


  // 1. Ensure the user row carries the provider role
  const newRoles = Array.from(new Set([...(user.roles ?? ['msme']), 'provider']))
  await upsertUserRow({
    id: user.id,
    ...(user.phone ? { phone: user.phone } : {}),
    ...(user.email ? { email: user.email } : {}),
    ...(d.fullName ? { fullName: d.fullName } : {}),
    roles: newRoles,
    preferredLocale: d.preferredLocale,
  })

  // 2. Resolve category slugs → ids (validates they exist)
  const { data: cats, error: catLookupErr } = await admin
    .from('categories')
    .select('id, slug')
    .in('slug', d.categorySlugs)
  if (catLookupErr) {
    return serverError('[profile/provider POST] category lookup:', catLookupErr)
  }
  if (!cats || cats.length === 0) {
    return NextResponse.json({ error: 'No valid categories selected' }, { status: 422 })
  }
  const slugToId = new Map(cats.map((c) => [c.slug, c.id]))

  // 3. Upsert provider_profiles. Generate a unique slug on first create.
  const { data: existing } = await admin
    .from('provider_profiles')
    .select('id, slug, status')
    .eq('user_id', user.id)
    .maybeSingle()

  // Re-registration guard: only brand-new applicants and rejected reapplicants
  // may (re)submit. Without this, an approved provider re-running onboarding
  // would reset themselves to under_review and wipe every verification badge.
  if (existing && existing.status !== 'rejected' && existing.status !== 'pending_kyc') {
    return NextResponse.json(
      { error: 'Provider profile already exists. Edit it from your partner dashboard instead.' },
      { status: 409 },
    )
  }

  const slug = existing?.slug ?? `${slugify(d.displayName)}-${randomSuffix()}`

  const { data: profile, error: profileErr } = await admin
    .from('provider_profiles')
    .upsert(
      {
        user_id: user.id,
        legal_name: d.legalName,
        display_name: d.displayName,
        slug,
        about: d.about ?? null,
        gstin: d.gstin ?? null,
        pan: d.pan ?? null,
        state: d.state,
        city: d.city ?? null,
        languages: d.languages,
        status: 'under_review',
      },
      { onConflict: 'user_id' },
    )
    .select('id')
    .single()

  if (profileErr || !profile) {
    return serverError('[profile/provider POST] upsert profile:', profileErr)
  }
  const providerId = profile.id

  // Best-effort depth fields (migration 0015). Deliberately a separate update
  // so a database that hasn't run 0015 yet fails THIS write with a logged
  // error while the submission itself still succeeds.
  if (d.yearsExperience || d.website) {
    const { error: depthErr } = await admin
      .from('provider_profiles')
      .update({
        ...(d.yearsExperience ? { years_experience: d.yearsExperience } : {}),
        ...(d.website ? { website: d.website } : {}),
      })
      .eq('id', providerId)
    if (depthErr) console.error('[profile/provider POST] depth fields (run migration 0015?):', depthErr)
  }

  // 4. Category links (replace existing set)
  await admin.from('provider_categories').delete().eq('provider_id', providerId)
  const catRows = Array.from(slugToId.values()).map((category_id) => ({
    provider_id: providerId,
    category_id,
  }))
  if (catRows.length > 0) {
    const { error: catErr } = await admin.from('provider_categories').insert(catRows)
    if (catErr) console.error('[profile/provider POST] categories:', catErr)
  }

  // 5. Verification records (replace existing set). One row per concrete item.
  await admin.from('provider_verifications').delete().eq('provider_id', providerId)
  const verifications: {
    provider_id: string
    kind: string
    value: string
    document_url: string | null
    status: string
  }[] = []
  if (d.gstin) {
    verifications.push({ provider_id: providerId, kind: 'gstin', value: d.gstin, document_url: null, status: 'pending' })
  }
  if (d.pan) {
    verifications.push({ provider_id: providerId, kind: 'pan', value: d.pan, document_url: null, status: 'pending' })
  }
  for (const [categorySlug, upload] of Object.entries(d.credentialUploads)) {
    // Canonical professional-body kind (icai/icsi/bar_council/…) so badges,
    // credential-first cards, and the search RPC's headline credential all
    // recognise the row. `value` carries the membership number when given —
    // that is what the admin verifies against the issuing body's register.
    const canonicalKind =
      (upload.kind && CREDENTIAL_VERIFICATION_KIND[upload.kind as CredentialOption]) || 'credential'
    verifications.push({
      provider_id: providerId,
      kind: canonicalKind,
      value: upload.number?.trim() || categorySlug,
      document_url: upload.url ?? upload.path ?? null,
      status: 'pending',
    })
  }
  if (verifications.length > 0) {
    const { error: verErr } = await admin.from('provider_verifications').insert(verifications)
    if (verErr) console.error('[profile/provider POST] verifications:', verErr)
  }

  // 6. Bank account (encrypted account number). Upsert by provider_id.
  // encryptColumn throws in production if COLUMN_ENCRYPTION_KEY is unset/invalid
  // (it refuses a default key for bank data). Catch it so the whole submit fails
  // with a logged, diagnosable error instead of a silent 500.
  let accountNumberEnc: string
  try {
    accountNumberEnc = encryptColumn(d.bankAccount)
  } catch (e) {
    // Distinct, non-secret code so a missing/invalid COLUMN_ENCRYPTION_KEY is
    // diagnosable in prod instead of a silent 500. Full detail logged server-side.
    console.error('[profile/provider POST] bank encryption — check COLUMN_ENCRYPTION_KEY:', e)
    return NextResponse.json({ error: 'bank_encryption_unconfigured' }, { status: 503 })
  }
  // penny_drop_verified is SERVER-set: it requires a recorded /kyc/verify-bank
  // success for this user + this exact account|IFSC within the last 24h from a
  // real vendor (the dev stub never counts). d.bankVerified is deliberately
  // ignored — a client flag must never be able to clear a payout hold.
  const fingerprint = fingerprintColumn(`${d.bankAccount}|${d.bankIfsc}`)
  const { data: bankVerification } = await admin
    .from('bank_account_verifications')
    .select('verified, stub')
    .eq('user_id', user.id)
    .eq('account_fingerprint', fingerprint)
    .gte('created_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const pennyDropVerified = Boolean(bankVerification?.verified) && !bankVerification?.stub

  const { error: bankErr } = await admin.from('provider_bank_accounts').upsert(
    {
      provider_id: providerId,
      account_number_enc: accountNumberEnc,
      ifsc: d.bankIfsc,
      account_holder: d.bankHolder,
      penny_drop_verified: pennyDropVerified,
    },
    { onConflict: 'provider_id' },
  )
  if (bankErr) {
    return serverError('[profile/provider POST] bank account:', bankErr)
  }

  return NextResponse.json({ success: true, providerId, slug, status: 'under_review' })
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}
