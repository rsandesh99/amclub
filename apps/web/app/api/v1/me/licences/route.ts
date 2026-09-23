import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { licenceCreateSchema } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createLicence, isObligationsOn, listMyLicences } from '@/lib/licences'

/**
 * Experience v3 E9b (FR-9.5, F7; D-PRD5, dark). GET — the caller's licences,
 * soonest expiry first. POST — add one by hand, or `{fromOrderId}` to confirm
 * what the provider recorded on the caller's finished order. 404 while
 * `obligations_enabled` is off.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function gate() {
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return { res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const
  if (!(await isObligationsOn())) return { res: NextResponse.json({ error: 'Not found' }, { status: 404 }) } as const
  const delegated = await requireNotDelegated('me/licences')
  if (delegated) return { res: delegated } as const
  return { supabase, userId } as const
}

export async function GET() {
  const g = await gate()
  if ('res' in g) return g.res
  return NextResponse.json({ licences: await listMyLicences(g.supabase) }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: NextRequest) {
  const g = await gate()
  if ('res' in g) return g.res
  const parsed = licenceCreateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body', code: 'invalid_body', issues: parsed.error.flatten() }, { status: 422 })
  const r = await createLicence(g.supabase, g.userId, parsed.data)
  if (!r.ok) return NextResponse.json({ error: r.code, code: r.code }, { status: r.status })
  return NextResponse.json({ licence: r.licence }, { status: 201 })
}
