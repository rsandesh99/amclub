import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { isOnFor } from '@/lib/experiments'
import { listMyInvoices } from '@/lib/invoices/queries'

/**
 * GET /api/v1/me/invoices (PRD Experience v3 E13 FR-13.3, flag `mobile`) — the
 * buyer's GST invoices for the mobile Invoices screen: the same rows the web
 * /app/invoices page renders, each with a 15-minute signed PDF link (never
 * cached). 404 while the flag is off.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isOnFor('mobile', userId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ invoices: await listMyInvoices(userId) }, { headers: { 'Cache-Control': 'private, no-store' } })
}
