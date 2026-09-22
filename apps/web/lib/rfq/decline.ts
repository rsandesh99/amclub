import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { declineMessageTemplate, messageMatchesLocaleScript, redactContactInfo, resolveDeclineLocale, type DeclineMessageLocale, type QuoteDeclineReason } from '@amclub/shared'
import { buildDeclineMessageParts, declineMessageSchema } from '@amclub/agent-core'
import { AGENT_ENABLED } from '@/lib/flags'
import { isAgentEnabledForUser } from '@/lib/agent/settings'
import { BudgetExceededError, boundedChatJson } from '@/lib/agent/bounded'
import { recordAiDecision } from '@/lib/mart/events'

/**
 * The courteous provider message on a buyer decline (S1.2 §4.5). When the
 * decline_message agent is on for the BUYER (AGENT_ENABLED + agents_enabled
 * .decline_message + cohort): one bounded call (run_id null), contact info
 * redacted belt-and-braces, one ai_decisions row (feature decline_message,
 * tool decline_quote) — the buyer's Decline tap is the confirmation. Otherwise
 * (agent off, budget exceeded, gateway error, wrong script): the fixed template
 * per reason × locale. A decline never fails because the model did.
 */

export interface ComposedDeclineMessage {
  message: string
  locale: DeclineMessageLocale
  source: 'agent' | 'template'
  decisionId: string | null
}

/** The provider's message locale: first languages[] entry we render, else their preferred locale, else en. */
export async function providerMessageLocale(admin: SupabaseClient, providerId: string): Promise<{ locale: DeclineMessageLocale; providerUserId: string | null }> {
  const { data: p } = await admin.from('provider_profiles').select('user_id, languages').eq('id', providerId).maybeSingle()
  const row = p as { user_id: string | null; languages: string[] | null } | null
  let preferred: string | null = null
  if (row?.user_id) {
    const { data: u } = await admin.from('users').select('preferred_locale').eq('id', row.user_id).maybeSingle()
    preferred = (u as { preferred_locale?: string | null } | null)?.preferred_locale ?? null
  }
  return { locale: resolveDeclineLocale(row?.languages ?? null, preferred), providerUserId: row?.user_id ?? null }
}

export async function composeDeclineMessage(
  admin: SupabaseClient,
  args: { quoteId: string; rfqId: string; reason: QuoteDeclineReason; note: string | null; rfqTitle: string | null; locale: DeclineMessageLocale; buyerUserId: string },
): Promise<ComposedDeclineMessage> {
  const fallback = (): ComposedDeclineMessage => ({ ...declineMessageTemplate(args.reason, args.locale), source: 'template', decisionId: null })
  const enabled = AGENT_ENABLED && (await isAgentEnabledForUser(admin, 'decline_message', args.buyerUserId))
  if (!enabled) return fallback()
  try {
    const res = await boundedChatJson(admin, {
      userId: args.buyerUserId,
      feature: 'decline_message',
      taskClass: 'decline_message',
      promptId: 'decline_message',
      promptVersion: 'v1',
      schema: declineMessageSchema,
      parts: buildDeclineMessageParts({ reason: args.reason, locale: args.locale, note: args.note, rfqTitle: args.rfqTitle, quoteId: args.quoteId, rfqId: args.rfqId }),
      temperature: 0.3,
      stub: () => declineMessageTemplate(args.reason, args.locale),
      meta: { quote_id: args.quoteId, rfq_id: args.rfqId, reason: args.reason, locale: args.locale },
    })
    const cleaned = redactContactInfo(res.data.message).text.trim().slice(0, 320)
    if (!cleaned || !messageMatchesLocaleScript(cleaned, args.locale)) return fallback()
    const decisionId = await recordAiDecision(
      admin,
      args.buyerUserId,
      {
        feature: 'decline_message',
        input_refs: { quote_id: args.quoteId, rfq_id: args.rfqId, reason: args.reason, locale: args.locale },
        proposed: { message: res.data.message },
        final: { message: cleaned },
      },
      { runId: null, tool: 'decline_quote' },
    )
    return { message: cleaned, locale: args.locale, source: 'agent', decisionId }
  } catch (e) {
    if (!(e instanceof BudgetExceededError)) console.error('[decline-message] gateway', (e as Error).message)
    return fallback()
  }
}
