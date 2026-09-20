import type { RfqTemplate } from '@amclub/shared'
import { envelope } from '../untrusted/envelope'
import type { ChatParts } from '../llm/gateway'

/**
 * Prompt parts for `rfq_quality@v1` (S1.5). The buyer's words — title, the
 * string form answers as JSON, the voice transcript when present — enter ONLY
 * as Envelopes in `untrusted`. The trusted block carries what the platform
 * owns: today, locale, category, the template's field list (names, labels,
 * required, type — never option values, never the buyer's answers) and the
 * deterministic precheck result so the model does not repeat rule gaps. A
 * unit test asserts no buyer string ever appears in `trusted`.
 */
export interface RfqQualityPartsInput {
  rfqId: string
  /** IST date, YYYY-MM-DD. */
  today: string
  locale: string
  categorySlug: string
  template: RfqTemplate | null
  precheck: { missingRequired: string[]; gaps: string[]; risks: string[] }
  title: string
  details: Record<string, unknown>
  voiceTranscript?: string | null
}

/** Only string answers cross into the prompt; numbers/objects are not buyer prose. */
export function stringDetails(details: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(details ?? {})) if (typeof v === 'string' && v.trim()) out[k] = v
  return out
}

export function buildRfqQualityParts(input: RfqQualityPartsInput): ChatParts {
  const fields = input.template?.fields ?? []
  const trusted = [
    `today: ${input.today}`,
    `locale: ${input.locale || 'en'}`,
    `category: ${input.categorySlug}`,
    fields.length
      ? `template_fields: ${fields.map((f) => `${f.name} ("${f.label_en}", ${f.required ? 'required' : 'optional'}, ${f.type})`).join('; ')}`
      : 'template_fields: none',
    `rule_gaps: ${[...input.precheck.missingRequired, ...input.precheck.gaps].join(', ') || 'none'}`,
    `rule_risks: ${input.precheck.risks.join(', ') || 'none'}`,
  ]
  const untrusted = [
    envelope(input.title, { kind: 'rfq_title', id: input.rfqId }),
    envelope(JSON.stringify(stringDetails(input.details)), { kind: 'rfq_details', id: input.rfqId }),
  ]
  if (input.voiceTranscript && input.voiceTranscript.trim()) {
    untrusted.push(envelope(input.voiceTranscript, { kind: 'voice_transcript', id: input.rfqId }))
  }
  return { trusted, untrusted }
}
