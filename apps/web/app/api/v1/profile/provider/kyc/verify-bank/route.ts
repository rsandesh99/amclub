import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionUser } from '@/lib/auth/session'
import { getKycClient } from '@/lib/kyc'
import { createAdminClient } from '@/lib/supabase/server'
import { fingerprintColumn } from '@/lib/crypto'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

const bodySchema = z.object({
  accountNumber: z.string().min(9).max(18),
  ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code'),
  holderName: z.string().min(2),
})

export async function POST(request: NextRequest) {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Paid external API — strict per-user cap to prevent bill-drain.
  const rl = await enforce(limiters.kyc, `kyc:bank:${user.id}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const kyc = getKycClient()
  const result = await kyc.verifyBankAccount(parsed.data)

  // Persist the answer SERVER-side (keyed fingerprint, never the number) so
  // onboarding can set penny_drop_verified from this record instead of a
  // client-sent flag. Attempts are recorded whether or not they verified.
  const admin = await createAdminClient()
  const { error: recErr } = await admin.from('bank_account_verifications').insert({
    user_id: user.id,
    account_fingerprint: fingerprintColumn(`${parsed.data.accountNumber}|${parsed.data.ifsc}`),
    ifsc: parsed.data.ifsc,
    account_holder: parsed.data.holderName,
    verified: result.verified,
    stub: result.stub ?? false,
    provider: result.stub ? 'stub' : 'surepass',
    result: { accountHolderName: result.accountHolderName ?? null, error: result.error ?? null },
  })
  if (recErr) console.error('[kyc/verify-bank] could not record verification result:', recErr.message)

  if (!result.verified) {
    return NextResponse.json(
      { error: result.error ?? 'Bank account verification failed', stub: result.stub },
      { status: 422 },
    )
  }

  return NextResponse.json({
    verified: true,
    accountHolderName: result.accountHolderName,
    stub: result.stub ?? false,
  })
}
