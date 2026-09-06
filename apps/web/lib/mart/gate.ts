import 'server-only'
import { NextResponse } from 'next/server'
import { notFound } from 'next/navigation'
import { MART_ENABLED } from '@/lib/flags'

/**
 * AMC Mart flag gate (MART_DESIGN.md §0 dark-build rules). Every Mart API
 * route calls martApiGate() FIRST and every Mart page calls martPageGate()
 * FIRST — while MART_ENABLED=false the surfaces do not exist (hard 404, same
 * as COUPONS_ENABLED's pattern), so nothing downstream can run.
 */
export function martApiGate(): NextResponse | null {
  if (MART_ENABLED) return null
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

export function martPageGate(): void {
  if (!MART_ENABLED) notFound()
}
