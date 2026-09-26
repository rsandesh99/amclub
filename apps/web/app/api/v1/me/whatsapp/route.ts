import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { WA_NOTICE_VERSION, waConsentUpdateSchema, waLocaleFor } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { clientIp, enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { captureServerEvent } from '@/lib/analytics/server'
import { accountPhoneDigits, grantWhatsAppPersonas, readWaConsentState, recordWebWaConsent, revokeWhatsAppGrants } from '@/lib/whatsapp/consent'

/**
 * ADR-030 §2 — the signed-in person's WhatsApp consent (settings toggles, the signup / checkout checkbox; web and
 * mobile). Consent is per phone (the account's own users.phone) and purpose, written only by record_wa_consent() on the
 * service role after these checks; it works whatever AGENT_ENABLED says (withdrawing must always be possible).
 *
 *   GET  → WaConsentState + `ready` (false until migration 0086 is applied).
 *   POST { purpose, optIn, source, noticeVersion } → the new state. The person's own session only (a delegated agent
 *        token → 403); noticeVersion must be the current WA_NOTICE_VERSION (409 notice_changed: the screen showed an
 *        older notice); no phone on the account → 422 phone_required; 0086 missing → 503 not_ready.
 *        `assistant` opt-in creates the WhatsApp agent grant per persona held (audit B3); its opt-out revokes them.
 *        Opting out of `transactional` is that purpose only — not a full STOP.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  const admin = await createAdminClient()
  return NextResponse.json(await readWaConsentState(admin, userId), { headers: NO_STORE })
}

export async function POST(request: NextRequest) {
  // consent is the person's own act: no agent tool wraps this route, so a delegated token is refused first
  const delegated = await requireNotDelegated('POST /me/whatsapp')
  if (delegated) return delegated
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  const rl = await enforce(limiters.authed, `wa-consent:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const parsed = waConsentUpdateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body', issues: parsed.error.flatten() }, { status: 422, headers: NO_STORE })
  const body = parsed.data
  if (body.noticeVersion !== WA_NOTICE_VERSION) return NextResponse.json({ error: 'notice_changed', noticeVersion: WA_NOTICE_VERSION }, { status: 409, headers: NO_STORE })

  const admin = await createAdminClient()
  const digits = await accountPhoneDigits(admin, userId)
  if (!digits) return NextResponse.json({ error: 'phone_required' }, { status: 422, headers: NO_STORE })
  const { data: me } = await admin.from('users').select('preferred_locale').eq('id', userId).maybeSingle()
  const locale = waLocaleFor((me as { preferred_locale?: string | null } | null)?.preferred_locale)
  const ip = clientIp(request)
  const userAgent = request.headers.get('user-agent')

  const r = await recordWebWaConsent(admin, { userId, phoneDigits: digits, purpose: body.purpose, optIn: body.optIn, source: body.source, locale, ip, userAgent })
  if (r === 'not_ready') return NextResponse.json({ error: 'not_ready' }, { status: 503, headers: NO_STORE })
  if (r === 'error') return NextResponse.json({ error: 'save_failed' }, { status: 500, headers: NO_STORE })

  // delegation follows the assistant purpose (consent is separate from delegation; START does the same on WhatsApp)
  if (body.purpose === 'assistant') {
    if (body.optIn) {
      await grantWhatsAppPersonas(admin, userId, digits, {
        locale,
        surface: body.source === 'mobile_settings' ? 'mobile' : 'web',
        source: body.source,
        ip,
        user_agent: userAgent,
        text_version: WA_NOTICE_VERSION,
        notice_version: WA_NOTICE_VERSION,
        keyword: null,
        purposes: ['assistant'],
      })
    } else {
      await revokeWhatsAppGrants(admin, userId)
    }
  }
  captureServerEvent(userId, 'wa_consent_changed', { purpose: body.purpose, optIn: body.optIn, source: body.source })
  return NextResponse.json(await readWaConsentState(admin, userId), { headers: NO_STORE })
}
