import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  clarifyLocaleFor,
  clarifyQuestionSchema,
  needsClarification,
  rfqFieldLabel,
  stubClarifyQuestion,
  type ClarifyQuestion,
  type RfqTemplate,
  type VoiceParse,
} from '@amclub/shared'
import { buildClarifyParts } from '@amclub/agent-core'
import { AGENT_ENABLED } from '@/lib/flags'
import { BudgetExceededError, boundedChatJson } from '@/lib/agent/bounded'
import { getAgentSetting, isAgentEnabledForUser } from '@/lib/agent/settings'
import { insertIntakeExtraction } from '@/lib/agent/intake'
import { logAiInvocation } from '@/lib/voice/invocations'
import { getSynthesizer, synthesizerVendorTag, ttsLanguageCode } from '@/lib/voice/tts'
import { VendorHttpError } from '@/lib/voice/types'

/**
 * S1.8 — the ONE clarifying question after a first-round voice parse. Runs only
 * when: no `prior` (the route enforces one round), AGENT_ENABLED, the buyer is
 * cohorted for `rfq_clarify`, and the shared rule finds a gap. One bounded
 * live-tier call (rfq_clarify@v1); any failure falls back to the fixed
 * per-gap question (never blocks the reply). Optional TTS when
 * clarify_tts_enabled (paid; logged as step 'tts'; at most once per clip).
 * Every question becomes one rfq_intake_extractions row (kind 'clarify') whose
 * id the client echoes on POST /api/v1/rfq.
 */

const MAX_AUDIO_DATA_URL = 400_000

export type ClarifyReply = ClarifyQuestion & { audio_data_url: string | null; extraction_id: string }

export async function loadTemplate(admin: SupabaseClient, categorySlug: string | null): Promise<RfqTemplate | null> {
  if (!categorySlug) return null
  const { data } = await admin.from('categories').select('rfq_template').eq('slug', categorySlug).maybeSingle()
  return ((data as { rfq_template?: RfqTemplate | null } | null)?.rfq_template ?? null) as RfqTemplate | null
}

/** Names of the template's required fields (round-two trusted `required_fields`). */
export async function requiredFieldsFor(admin: SupabaseClient, categorySlug: string | null): Promise<string[]> {
  const t = await loadTemplate(admin, categorySlug)
  return (t?.fields ?? []).filter((f) => f.required && f.type !== 'textarea' && f.name !== 'additional_details').map((f) => f.name)
}

export async function maybeClarify(
  admin: SupabaseClient,
  args: { userId: string; parse: VoiceParse; transcript: string; languageCode: string; durationMs: number },
): Promise<ClarifyReply | null> {
  if (!AGENT_ENABLED) return null
  if (!(await isAgentEnabledForUser(admin, 'rfq_clarify', args.userId))) return null

  const template = await loadTemplate(admin, args.parse.category_slug)
  const need = needsClarification(args.parse, template)
  if (!need) return null

  const locale = clarifyLocaleFor(args.languageCode)
  const requiredFieldLabels = (template?.fields ?? []).filter((f) => f.required && f.type !== 'textarea').map((f) => rfqFieldLabel(f, 'en'))
  const fieldLabel = need.field ? rfqFieldLabel(need.field, 'en') : null
  const parts = buildClarifyParts({ gap: need.gap, locale, categorySlug: args.parse.category_slug, requiredFieldLabels, transcript: args.transcript, transcriptId: 'clip' })
  const fallback = () => stubClarifyQuestion(need.gap, locale, fieldLabel)

  let question: ClarifyQuestion
  let model: string | null = null
  let stub = false
  let cost: number | null = null
  try {
    const res = await boundedChatJson(admin, {
      userId: args.userId,
      feature: 'rfq_intake',
      taskClass: 'rfq_clarify',
      promptId: 'rfq_clarify',
      promptVersion: 'v1',
      schema: clarifyQuestionSchema,
      parts,
      temperature: 0,
      stub: fallback,
      meta: { gap: need.gap, locale, category: args.parse.category_slug },
    })
    // The model must echo the gap and locale; anything else is the fixed question.
    question = res.data.gap === need.gap && res.data.locale === locale ? res.data : fallback()
    model = res.stub ? null : res.model
    stub = res.stub
    cost = res.costPaise
  } catch (e) {
    if (e instanceof BudgetExceededError) console.warn('[clarify] budget exceeded → fixed question', args.userId)
    else console.error('[clarify] gateway', (e as Error).message)
    question = fallback()
    stub = true
  }

  // Optional paid TTS — one per clip, only when the founder switched it on.
  let audioDataUrl: string | null = null
  let ttsUsed = false
  if ((await getAgentSetting(admin, 'clarify_tts_enabled')) === true) {
    ttsUsed = true
    const started = Date.now()
    try {
      const s = await getSynthesizer().synthesize(question.question, ttsLanguageCode(locale))
      await logAiInvocation(admin, { userId: args.userId, feature: 'rfq_intake', step: 'tts', taskClass: 'text_to_speech', vendor: s.vendor, status: s.stub ? 'stub' : 'ok', latencyMs: Date.now() - started, costEstPaise: null, inputBytes: question.question.length, outputChars: s.audioBase64?.length ?? 0, requestId: s.requestId, meta: { locale, gap: need.gap } })
      if (s.audioBase64) {
        const url = `data:${s.mime};base64,${s.audioBase64}`
        audioDataUrl = url.length <= MAX_AUDIO_DATA_URL ? url : null
      }
    } catch (e) {
      await logAiInvocation(admin, { userId: args.userId, feature: 'rfq_intake', step: 'tts', taskClass: 'text_to_speech', vendor: synthesizerVendorTag(), status: 'error', latencyMs: Date.now() - started, costEstPaise: null, error: (e as Error).message.slice(0, 500), ...(e instanceof VendorHttpError ? { meta: { vendor_status: e.status, vendor_body: e.body.slice(0, 4000) } } : {}) })
    }
  }

  const extractionId = await insertIntakeExtraction(admin, {
    userId: args.userId,
    kind: 'clarify',
    inputRefs: { audio_duration_ms: args.durationMs, transcript_chars: args.transcript.length, language_code: args.languageCode, gap: need.gap, locale, category: args.parse.category_slug, tts: ttsUsed, audio_returned: audioDataUrl !== null },
    proposed: question,
    model,
    stub,
    costEstPaise: cost,
  })
  return { ...question, audio_data_url: audioDataUrl, extraction_id: extractionId }
}
