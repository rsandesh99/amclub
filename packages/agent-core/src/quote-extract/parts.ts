import type { QuoteExtractKind } from '@amclub/shared'
import { envelope } from '../untrusted/envelope'
import type { ChatParts } from '../llm/gateway'

/**
 * Prompt parts for `quote_extract@v1` (S1.1 §5.7). The provider's free text
 * enters ONLY as an Envelope in `untrusted`; the trusted block carries facts
 * the platform owns (today, RFQ kind, goods unit/qty, locale). A unit test
 * asserts the text never appears in `trusted`.
 */
export interface QuoteExtractPartsInput {
  text: string
  rfqId: string
  /** IST date, YYYY-MM-DD. */
  today: string
  kind: QuoteExtractKind
  unit?: string | null
  qty?: number | null
  locale?: string | null
}

export function buildQuoteExtractParts(input: QuoteExtractPartsInput): ChatParts {
  const trusted = [`today: ${input.today}`, `rfq_kind: ${input.kind}`]
  if (input.kind === 'goods' && (input.unit || input.qty)) {
    trusted.push(`unit: ${input.unit ?? 'unknown'}, qty: ${input.qty ?? 'unknown'}`)
  }
  trusted.push(`locale: ${input.locale ?? 'en'}`)
  return {
    trusted,
    untrusted: [envelope(input.text, { kind: 'quote_text', id: input.rfqId })],
  }
}
