import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { corpusConsentSchema } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { captureServerEvent } from '@/lib/analytics/server'
import { corpusConsentOffered } from '@/lib/corpus'

/**
 * E15 FR-15.4 (F6) — "Help improve AMClub's Hindi and Telugu understanding".
 * An explicit opt-in (default off), revocable; revoking DELETES every corpus
 * row of this user (voice triples, image pairs). The user's own session only —
 * never a delegated agent token. Opting IN needs the `corpus_consent_enabled`
 * switch (404 while it is off); revoking always works.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = await createAdminClient()
  const { data } = await admin.from('users').select('corpus_consent_at').eq('id', userId).maybeSingle()
  return NextResponse.json({ on: !!data?.corpus_consent_at }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('me/corpus-consent')
  if (delegated) return delegated
  const parsed = corpusConsentSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 422 })
  const admin = await createAdminClient()
  if (parsed.data.on && !(await corpusConsentOffered(admin))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { error } = await admin.from('users').update({ corpus_consent_at: parsed.data.on ? new Date().toISOString() : null }).eq('id', userId)
  if (error) return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  let deleted = 0
  if (!parsed.data.on) {
    const [v, i] = await Promise.all([
      admin.from('corpus_voice_triples').delete().eq('user_id', userId).select('id'),
      admin.from('corpus_image_pairs').delete().eq('user_id', userId).select('id'),
    ])
    deleted = (v.data ?? []).length + (i.data ?? []).length
  }
  captureServerEvent(userId, 'corpus_consent_changed', { on: parsed.data.on, deleted })
  return NextResponse.json({ on: parsed.data.on, deleted })
}
