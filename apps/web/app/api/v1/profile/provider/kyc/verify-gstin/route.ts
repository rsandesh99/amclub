import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionUser } from '@/lib/auth/session'
import { getKycClient } from '@/lib/kyc'

const bodySchema = z.object({
  gstin: z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, 'Invalid GSTIN format'),
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
  const result = await kyc.verifyGstin(parsed.data.gstin)

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
