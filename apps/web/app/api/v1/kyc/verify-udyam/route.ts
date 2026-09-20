import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { udyamSchema } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { getKycClient, type KycClient } from '@/lib/kyc'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

/**
 * Udyam verified chip (S0.4). Verifies a Udyam registration for the caller's
 * MSME and/or provider profile, records EVERY attempt in udyam_verifications
 * (mirror of gstin_verifications), and sets the profile boolean ONLY from a
 * real, non-stub result — the dev stub never earns the chip. Cookie or Bearer.
 *
 * KYC_FAKE=verified (verify-trust only; never set in prod) swaps in a client
 * that returns a verified NON-stub result so the "real path sets it" branch is
 * exercisable without a paid Surepass call.
 */
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  udyam_number: udyamSchema,
  /** Which profile to attach to; defaults to whichever the user has (msme first). */
  target: z.enum(['msme', 'provider']).optional(),
})

function clientFor(): KycClient {
  if (process.env['KYC_FAKE'] === 'verified' && process.env['NODE_ENV'] !== 'production') {
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

export async function POST(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Paid external API — strict per-user cap to prevent bill-drain.
  const rl = await enforce(limiters.kyc, `kyc:udyam:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  const target = parsed.data.target ?? (actor.msmeId ? 'msme' : actor.providerId ? 'provider' : null)
  if (!target || (target === 'msme' && !actor.msmeId) || (target === 'provider' && !actor.providerId)) {
    return NextResponse.json({ error: 'No matching profile for this account' }, { status: 403 })
  }

  const result = await clientFor().verifyUdyam(parsed.data.udyam_number)
  const stub = result.stub ?? false

  const { error: recErr } = await admin.from('udyam_verifications').insert({
    user_id: userId,
    udyam_number: parsed.data.udyam_number,
    verified: result.verified,
    stub,
    provider: stub ? 'stub' : 'surepass',
    result: {
      enterpriseName: result.enterpriseName ?? null,
      majorActivity: result.majorActivity ?? null,
      state: result.state ?? null,
      registrationDate: result.registrationDate ?? null,
      error: result.error ?? null,
      target,
    },
  })
  if (recErr) console.error('[kyc/verify-udyam] could not record verification result:', recErr.message)

  if (!result.verified) {
    return NextResponse.json({ error: result.error ?? 'Udyam verification failed', stub }, { status: 422 })
  }

  // The chip is earned ONLY by a real, non-stub result.
  let chip = false
  if (!stub) {
    const table = target === 'msme' ? 'msme_profiles' : 'provider_profiles'
    const idCol = target === 'msme' ? actor.msmeId! : actor.providerId!
    const { error } = await admin
      .from(table)
      // provider_profiles has no udyam_number column (0000); only MSME profiles store the number.
      .update({ udyam_verified: true, ...(target === 'msme' ? { udyam_number: parsed.data.udyam_number } : {}), updated_at: new Date().toISOString() })
      .eq('id', idCol)
    if (error) console.error('[kyc/verify-udyam] could not set udyam_verified:', error.message)
    else chip = true
  }

  return NextResponse.json({ verified: true, stub, chip, enterpriseName: result.enterpriseName ?? null, target })
}
