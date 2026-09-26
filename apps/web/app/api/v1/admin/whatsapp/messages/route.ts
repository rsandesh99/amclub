import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { adminRead, NO_STORE } from '@/lib/privacy/route-guard'
import { waDeliveryLog, WA_OUTBOUND_STATUSES } from '@/lib/whatsapp/admin'
import { serverError } from '@/lib/api/errors'

/**
 * GET /api/v1/admin/whatsapp/messages?kind=&status=&error= (ADR-030 §6) — the delivery log: outbound messages of the
 * last 7 days (kind, template, language, status, error, masked phone, time), counts by status and the top error codes.
 * Bodies are never in the list; the single-row view reads one and is audit-logged.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const querySchema = z.object({
  kind: z.string().regex(/^[a-z0-9_]{1,60}$/).optional(),
  status: z.enum(WA_OUTBOUND_STATUSES).optional(),
  error: z.coerce.number().int().min(0).max(10_000_000).optional(),
})

export async function GET(request: NextRequest) {
  const g = await adminRead()
  if (g.error) return g.error
  const sp = request.nextUrl.searchParams
  const parsed = querySchema.safeParse({ kind: sp.get('kind') || undefined, status: sp.get('status') || undefined, error: sp.get('error') || undefined })
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  try {
    const log = await waDeliveryLog(g.admin, { kind: parsed.data.kind ?? null, status: parsed.data.status ?? null, errorCode: parsed.data.error ?? null })
    return NextResponse.json(log, { headers: NO_STORE })
  } catch (e) {
    return serverError('[admin/whatsapp/messages]', e)
  }
}
