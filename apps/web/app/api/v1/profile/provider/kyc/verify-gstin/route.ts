import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionUser } from '@/lib/auth/session'
import { getKycClient } from '@/lib/kyc'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

const bodySchema = z.object({
  gstin: z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, 'Invalid GSTIN format'),
})

export async function POST(request: NextRequest) {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Paid external API — strict per-user cap to prevent bill-drain.
  const rl = await enforce(limiters.kyc, `kyc:gstin:${user.id}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const kyc = getKycClient()
  const result = await kyc.verifyGstin(parsed.data.gstin)

  // S2.2 — record EVERY attempt (success or failure) server-side, mirroring
  // /kyc/verify-bank: the goods activation gate consumes this table, never a
  // client-sent flag. `result` stores GST-registry business facts only.
  const admin = await createAdminClient()
  const { error: recErr } = await admin.from('gstin_verifications').insert({
    user_id: user.id,
    gstin: parsed.data.gstin,
    verified: result.verified,
    stub: result.stub ?? false,
    provider: result.stub ? 'stub' : 'surepass',
    result: {
      legalName: result.legalName ?? null,
      tradeName: result.tradeName ?? null,
      state: result.state ?? null,
      registrationDate: result.registrationDate ?? null,
      isActive: result.isActive ?? null,
      error: result.error ?? null,
    },
  })
  if (recErr) console.error('[kyc/verify-gstin] could not record verification result:', recErr.message)

  if (!result.verified) {
    return NextResponse.json(
      { error: result.error ?? 'GSTIN verification failed', stub: result.stub },
      { status: 422 },
    )
  }

  return NextResponse.json({
    verified: true,
    legalName: result.legalName,
    tradeName: result.tradeName,
    stub: result.stub ?? false,
  })
}
