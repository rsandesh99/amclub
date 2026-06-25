import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionUser } from '@/lib/auth/session'
import { getKycClient } from '@/lib/kyc'

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

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const kyc = getKycClient()
  const result = await kyc.verifyBankAccount(parsed.data)

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
