import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { kycOwnership, type KycAttemptOutcome, type KycOwnership } from '@amclub/shared'
import { getRequestUser } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { getKycClient } from '@/lib/kyc'
import { kycReferences } from '@/lib/kyc/ownership'
import { createAdminClient } from '@/lib/supabase/server'
import { fingerprintColumn } from '@/lib/crypto'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

const bodySchema = z.object({
  accountNumber: z.string().min(9).max(18),
  ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code'),
  holderName: z.string().min(2),
  /** ADR 028 — the GSTIN the wizard verified, whose registry names the holder must match (defaults to the profile's). */
  gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, 'Invalid GSTIN format').optional(),
})

export async function POST(request: NextRequest) {
  const user = await getRequestUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // E13 — Bearer is now accepted (the native wizard); a delegated agent token never is (S1.6: the agent never verifies or writes the profile).
  const delegated = await requireNotDelegated('profile/provider/kyc/verify-bank')
  if (delegated) return delegated

  // Paid external API — strict per-user cap to prevent bill-drain.
  const rl = await enforce(limiters.kyc, `kyc:bank:${user.id}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const kyc = getKycClient()
  const result = await kyc.verifyBankAccount({ accountNumber: parsed.data.accountNumber, ifsc: parsed.data.ifsc, holderName: parsed.data.holderName })
  const admin = await createAdminClient()

  // Audit M12 / ADR 028 — penny drop proves the account exists; the holder name
  // the bank returns must also match the business's GST-locked legal / trade
  // name. A mismatch is recorded for ops review and never sets penny_drop_verified.
  let outcome: KycAttemptOutcome = result.stub ? 'stub' : result.verified ? 'verified' : 'not_verified'
  let match: KycOwnership | null = null
  if (result.verified && !result.stub) {
    const refs = await kycReferences(admin, { userId: user.id, target: 'provider', gstin: parsed.data.gstin ?? null, fallbackToLatestGstin: true })
    match = kycOwnership({ name: result.accountHolderName ?? null }, refs)
    if (match.outcome !== 'verified') outcome = 'name_mismatch'
  }

  // Persist the answer SERVER-side (keyed fingerprint, never the number) so
  // onboarding can set penny_drop_verified from this record instead of a
  // client-sent flag. Attempts are recorded whether or not they verified.
  const { error: recErr } = await admin.from('bank_account_verifications').insert({
    user_id: user.id,
    account_fingerprint: fingerprintColumn(`${parsed.data.accountNumber}|${parsed.data.ifsc}`),
    ifsc: parsed.data.ifsc,
    account_holder: parsed.data.holderName,
    verified: result.verified,
    stub: result.stub ?? false,
    provider: result.stub ? 'stub' : 'surepass',
    outcome,
    result: { accountHolderName: result.accountHolderName ?? null, error: result.error ?? null, match },
  })
  if (recErr) console.error('[kyc/verify-bank] could not record verification result:', recErr.message)

  if (!result.verified) {
    return NextResponse.json(
      { error: result.error ?? 'Bank account verification failed', stub: result.stub },
      { status: 422 },
    )
  }

  // The account exists, so the wizard may go on; a holder-name mismatch only
  // keeps payouts on hold until ops review it (nameMatch false).
  return NextResponse.json({
    verified: true,
    accountHolderName: result.accountHolderName,
    stub: result.stub ?? false,
    nameMatch: outcome !== 'name_mismatch',
  })
}
