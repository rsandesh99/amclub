import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { listMyQuotesForProvider } from '@/lib/rfq/queries'

/**
 * GET /api/v1/partner/quotes (S2.3) — the provider's own quotes (newest activity first, ≤ 10) with the request's
 * facts and each quote's real status + price. Read-only, party-scoped to the session / delegated user; the Support
 * agent's provider-hat lookups read it under the token (scope support_lookup; a no-op for ordinary sessions).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const scope = await requireToolScope('support_lookup')
  if (scope) return scope
  return NextResponse.json({ quotes: await listMyQuotesForProvider(userId) }, { headers: { 'Cache-Control': 'private, no-store' } })
}
