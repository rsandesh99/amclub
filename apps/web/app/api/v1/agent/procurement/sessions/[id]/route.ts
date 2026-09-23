import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { procurementRouteContext, procurementThread, PROCUREMENT_NO_STORE } from '@/lib/agent/procurement'

/** GET /api/v1/agent/procurement/sessions/[id] (S3.1) — one session's thread (WhatsApp + web turns), read under the buyer's own session (RLS owner read); another buyer's id reads nothing (404). */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await procurementRouteContext('GET /agent/procurement/sessions/[id]')
  if (ctx.error) return ctx.error
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const thread = await procurementThread(ctx.supabase, id)
  if (!thread.session) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(thread, { headers: PROCUREMENT_NO_STORE })
}
