import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { orderLicenceFactsSchema } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { getOrderLicenceFacts, isObligationsOn, recordOrderLicenceFacts } from '@/lib/licences'

/**
 * Experience v3 E9b (FR-9.5) — the certificate a registration order produced.
 * POST (the order's provider, from the work stage on): record or correct the
 * licence type, number, dates and authority. GET (either party): the recorded
 * facts and whether the buyer already added them to their licences. 404 while
 * `obligations_enabled` is off.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function gate(id: string) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return { res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const
  if (!(await isObligationsOn()) || !UUID.test(id)) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) } as const
  const delegated = await requireNotDelegated('orders/licence-facts')
  if (delegated) return { res: delegated } as const
  return { userId } as const
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const g = await gate(id)
  if ('res' in g) return g.res
  const facts = await getOrderLicenceFacts(g.userId, id)
  if (facts === 'forbidden') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json({ facts }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const g = await gate(id)
  if ('res' in g) return g.res
  const parsed = orderLicenceFactsSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body', code: 'invalid_body' }, { status: 422 })
  const r = await recordOrderLicenceFacts(g.userId, id, parsed.data)
  if (!r.ok) return NextResponse.json({ error: r.code, code: r.code }, { status: r.status })
  return NextResponse.json({ ok: true })
}
