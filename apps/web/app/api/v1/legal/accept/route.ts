import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { legalAcceptSchema } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { isProviderAccount, missingLegalDocs, recordLegalAcceptances } from '@/lib/legal/acceptance'
import { serverError } from '@/lib/api/errors'
import { requireNotDelegated } from '@/lib/agent/scope'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Record acceptance of legal documents at their CURRENT versions (cookie or
 * Bearer). Append-only; re-posting an already-accepted doc is a no-op.
 * Signup calls this BEFORE creating a profile — the profile endpoints refuse
 * (403 legal_acceptance_required) until the required docs are on record.
 */
export async function POST(request: NextRequest) {
  // Audit wave 3: no agent tool wraps this route, so a delegated agent token is refused.
  const delegated = await requireNotDelegated('POST /legal/accept')
  if (delegated) return delegated
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })

  const parsed = legalAcceptSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422, headers: NO_STORE })

  const admin = await createAdminClient()

  // terms_acceptances.user_id references public.users — a brand-new OTP/Google
  // signup accepts BEFORE its profile POST creates that row. Insert a minimal
  // row only when none exists (never overwrite an existing user's roles/name).
  const { data: existing } = await admin.from('users').select('id').eq('id', userId).maybeSingle()
  if (!existing) {
    const { data: { user: authUser } } = await supabase.auth.getUser()
    const { error: uErr } = await admin.from('users').insert({
      id: userId,
      phone: authUser?.phone || null,
      email: authUser?.email || null,
      roles: ['msme'],
    })
    if (uErr && uErr.code !== '23505') return serverError('[legal/accept] users row:', uErr)
  }

  const forwarded = request.headers.get('x-forwarded-for')
  const payload = {
    ip: forwarded ? forwarded.split(',')[0]!.trim() : null,
    user_agent: request.headers.get('user-agent')?.slice(0, 300) ?? null,
    locale: parsed.data.locale ?? request.headers.get('accept-language')?.split(',')[0] ?? null,
    surface: parsed.data.surface,
  }

  try {
    const written = await recordLegalAcceptances(admin, userId, parsed.data.docs, payload)
    const isProvider = await isProviderAccount(admin, userId)
    const required = await missingLegalDocs(admin, userId, isProvider)
    return NextResponse.json({ ok: true, written, required }, { headers: NO_STORE })
  } catch (e) {
    return serverError('[legal/accept]', e)
  }
}
