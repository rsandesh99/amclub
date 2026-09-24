import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { kycOwnership, udyamClaimKey, udyamSchema, type KycAttemptOutcome, type KycOwnership } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { getKycClient, type KycClient, type UdyamVerifyResult } from '@/lib/kyc'
import { kycReferences } from '@/lib/kyc/ownership'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

/**
 * Udyam verified chip (S0.4; ownership since audit M12 / ADR 028). Verifies a
 * Udyam registration for the caller's MSME and/or provider profile and records
 * EVERY attempt in udyam_verifications with an `outcome`. The chip is set ONLY
 * when a real (non-stub) vendor record is the caller's own business — its PAN /
 * GSTIN is the caller's, or its enterprise name matches the caller's GST-locked
 * legal / trade name (shared `kycOwnership`). Otherwise the attempt is
 * `name_mismatch` (422 `udyam_name_mismatch`) and waits for ops review in the
 * admin verification queue. One account holds a Udyam number: a claim held by
 * another account is 409 `udyam_already_claimed` (checked before the paid vendor
 * call and enforced by the unique index). The dev stub never earns the chip.
 * Cookie or Bearer; a delegated agent token never verifies.
 *
 * KYC_FAKE=verified (verify-trust only; never on a production build or a Vercel
 * deployment) swaps in a client that returns a verified NON-stub result so the
 * "real path" branches are exercisable without a paid Surepass call.
 */
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  udyam_number: z.string().trim().toUpperCase().pipe(udyamSchema),
  /** Which profile to attach to; defaults to whichever the user has (msme first). */
  target: z.enum(['msme', 'provider']).optional(),
})

function clientFor(): KycClient {
  const fakeAllowed = process.env['NODE_ENV'] !== 'production' && !process.env['VERCEL_ENV']
  if (process.env['KYC_FAKE'] === 'verified' && fakeAllowed) {
    const real = getKycClient()
    return {
      ...real,
      async verifyUdyam() {
        return { verified: true, enterpriseName: 'Fake Verified Enterprise', state: 'KA', registrationDate: '2022-02-02' }
      },
    }
  }
  return getKycClient()
}

type Admin = Awaited<ReturnType<typeof createAdminClient>>

async function record(
  admin: Admin,
  row: { userId: string; udyam: string; verified: boolean; stub: boolean; provider: string; outcome: KycAttemptOutcome; releasedAt?: string; target: string; result?: UdyamVerifyResult; match?: KycOwnership },
): Promise<{ error: { code?: string; message: string } | null }> {
  const { error } = await admin.from('udyam_verifications').insert({
    user_id: row.userId,
    udyam_number: row.udyam,
    verified: row.verified,
    stub: row.stub,
    provider: row.provider,
    outcome: row.outcome,
    ...(row.releasedAt ? { released_at: row.releasedAt } : {}),
    result: {
      enterpriseName: row.result?.enterpriseName ?? null,
      majorActivity: row.result?.majorActivity ?? null,
      state: row.result?.state ?? null,
      registrationDate: row.result?.registrationDate ?? null,
      // Whether the vendor returned IDs, never the IDs themselves.
      vendorPan: row.result?.pan ? true : null,
      vendorGstin: row.result?.gstin ? true : null,
      error: row.result?.error ?? null,
      target: row.target,
      match: row.match ?? null,
    },
  })
  return { error }
}

/** The active claim on this number (outcome 'verified', not released), if any. */
async function activeClaim(admin: Admin, udyam: string): Promise<{ user_id: string } | null> {
  const { data } = await admin
    .from('udyam_verifications')
    .select('user_id, udyam_number')
    .ilike('udyam_number', udyam)
    .eq('outcome', 'verified')
    .is('released_at', null)
    .limit(1)
    .maybeSingle()
  return (data as { user_id: string } | null) ?? null
}

export async function POST(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('kyc/verify-udyam')
  if (delegated) return delegated

  // Paid external API — strict per-user cap to prevent bill-drain.
  const rl = await enforce(limiters.kyc, `kyc:udyam:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const udyam = udyamClaimKey(parsed.data.udyam_number)

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  const target = parsed.data.target ?? (actor.msmeId ? 'msme' : actor.providerId ? 'provider' : null)
  if (!target || (target === 'msme' && !actor.msmeId) || (target === 'provider' && !actor.providerId)) {
    return NextResponse.json({ error: 'No matching profile for this account' }, { status: 403 })
  }

  // One account per Udyam number — refused before the paid call.
  const held = await activeClaim(admin, udyam)
  if (held && held.user_id !== userId) {
    const { error } = await record(admin, { userId, udyam, verified: false, stub: false, provider: 'precheck', outcome: 'udyam_already_claimed', target })
    if (error) console.error('[kyc/verify-udyam] could not record the refused claim:', error.message)
    return NextResponse.json({ error: 'udyam_already_claimed' }, { status: 409 })
  }

  const result = await clientFor().verifyUdyam(udyam)
  const stub = result.stub ?? false
  const provider = stub ? 'stub' : 'surepass'

  if (!result.verified) {
    const { error } = await record(admin, { userId, udyam, verified: false, stub, provider, outcome: 'not_verified', target, result })
    if (error) console.error('[kyc/verify-udyam] could not record verification result:', error.message)
    return NextResponse.json({ error: result.error ?? 'Udyam verification failed', stub }, { status: 422 })
  }

  // The dev stub answers "verified" for anything: recorded, never a chip, never a claim.
  if (stub) {
    const { error } = await record(admin, { userId, udyam, verified: true, stub, provider, outcome: 'stub', target, result })
    if (error) console.error('[kyc/verify-udyam] could not record verification result:', error.message)
    return NextResponse.json({ verified: true, stub: true, chip: false, enterpriseName: result.enterpriseName ?? null, target })
  }

  // ADR 028 — the record must be the caller's own business.
  const refs = await kycReferences(admin, { userId, target })
  const match = kycOwnership({ name: result.enterpriseName ?? null, pan: result.pan ?? null, gstin: result.gstin ?? null }, refs)
  if (match.outcome !== 'verified') {
    const { error } = await record(admin, { userId, udyam, verified: true, stub, provider, outcome: 'name_mismatch', target, result, match })
    if (error) console.error('[kyc/verify-udyam] could not record the mismatch:', error.message)
    return NextResponse.json({ error: 'udyam_name_mismatch', verified: false, stub: false, chip: false, review: true, reason: match.reason, target }, { status: 422 })
  }

  // The claim. A repeat by the holder is recorded born-released: the first row stays the claim.
  const repeat = held?.user_id === userId
  const { error: claimErr } = await record(admin, {
    userId, udyam, verified: true, stub, provider, outcome: 'verified', target, result, match,
    ...(repeat ? { releasedAt: new Date().toISOString() } : {}),
  })
  if (claimErr) {
    if (claimErr.code === '23505') {
      // Another account claimed it between the check and now (the unique index decided).
      const { error } = await record(admin, { userId, udyam, verified: true, stub, provider, outcome: 'udyam_already_claimed', target, result, match })
      if (error) console.error('[kyc/verify-udyam] could not record the refused claim:', error.message)
      return NextResponse.json({ error: 'udyam_already_claimed' }, { status: 409 })
    }
    console.error('[kyc/verify-udyam] could not record the claim:', claimErr.message)
    return NextResponse.json({ error: 'kyc_record_failed' }, { status: 503 })
  }

  const table = target === 'msme' ? 'msme_profiles' : 'provider_profiles'
  const idCol = target === 'msme' ? actor.msmeId! : actor.providerId!
  const { error } = await admin
    .from(table)
    // provider_profiles has no udyam_number column (0000); only MSME profiles store the number.
    .update({ udyam_verified: true, ...(target === 'msme' ? { udyam_number: udyam } : {}), updated_at: new Date().toISOString() })
    .eq('id', idCol)
  if (error) console.error('[kyc/verify-udyam] could not set udyam_verified:', error.message)

  return NextResponse.json({ verified: true, stub: false, chip: !error, enterpriseName: result.enterpriseName ?? null, target, basis: match.basis })
}
