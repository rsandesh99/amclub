import type { SupportIntentOutput, SupportLocale } from '@amclub/shared'

/**
 * The keyless classifier (S2.3): a deterministic keyword map used when no LLM
 * key is configured (the rig, CI, a dark deploy). Same shape as the model's
 * output — no reply text — so the engine, the templates and the numbers rule
 * run unchanged. Never a guess at a number: order_ref is 'latest' or a
 * number copied from the message.
 */
export function stubSupportIntent(text: string, locale: SupportLocale, orderNumbers: readonly string[] = []): SupportIntentOutput {
  const t = text.toLowerCase()
  const base: SupportIntentOutput = { intent: 'other', as_role: null, order_ref: null, rfq_ref: null, how_to_topic: null, escalate: false, escalate_reason: null, ops_summary: null, language: locale }
  const mentioned = orderNumbers.find((n) => t.includes(n.toLowerCase())) ?? null
  const orderRef = mentioned ?? (/\b(order|ऑर्डर|ఆర్డర్|ஆர்டர்)\b/.test(t) ? 'latest' : null)
  if (/(idiot|useless|stupid|destroy)/.test(t)) return { ...base, intent: 'complaint', escalate: true, escalate_reason: 'abuse', ops_summary: 'The user wrote an abusive message.' }
  if (/(charged twice|deducted|paise kat|no order showing|money gone)/.test(t)) return { ...base, intent: 'payment_problem', escalate: true, escalate_reason: 'payment_problem', ops_summary: 'The user reports a payment problem.' }
  if (/(cheated|fraud|dhokha|scam|not what was promised|dispute|मोसం|मोसम|dhoka)/.test(t)) return { ...base, intent: 'dispute_language', order_ref: orderRef, escalate: true, escalate_reason: 'dispute_language', ops_summary: 'The user uses dispute language about their order.' }
  if (/(unacceptable|ignoring me|bekaar|worst|complain|no reply for|not responding)/.test(t)) return { ...base, intent: 'complaint', order_ref: orderRef, escalate: true, escalate_reason: 'complaint', ops_summary: 'The user complains about the counterparty or the service.' }
  if (/(talk to a person|speak to a person|human|real person|agent please|vyakti|व्यक्ति)/.test(t)) return { ...base, intent: 'how_to', how_to_topic: 'contact_human', escalate: true, escalate_reason: 'asked_for_human', ops_summary: 'The user asked to speak to a person.' }
  if (/(remind|nudge|tell (the|him|her|them)|follow up with)/.test(t)) return { ...base, intent: 'nudge_request', order_ref: orderRef ?? 'latest' }
  if (/(refund)/.test(t) && !/(how do i|how to)/.test(t)) return { ...base, intent: 'payment_status', order_ref: orderRef ?? 'latest' }
  if (/(how do i|how to|how does|kaise|ఎలా|எப்படி)/.test(t)) {
    const topic = /refund/.test(t) ? 'refund' : /cancel/.test(t) ? 'cancel' : /(fee|commission)/.test(t) ? 'fees' : /(bank|kyc|gstin|udyam)/.test(t) ? 'kyc_bank' : /(payout|paid)/.test(t) ? 'payout_timing' : /dispute/.test(t) ? 'dispute' : /(compare)/.test(t) ? 'compare_quotes' : /(accept)/.test(t) ? 'accept_quote' : /(pay\b|payment)/.test(t) ? 'pay' : /(verif)/.test(t) ? 'verification' : /(request|rfq|post)/.test(t) ? 'create_rfq' : 'other'
    return { ...base, intent: 'how_to', how_to_topic: topic }
  }
  if (/(payout|when will i be paid|paid for|paise kab|డబ్బు|பணம்)/.test(t)) return { ...base, intent: 'payout_status', as_role: 'provider', order_ref: orderRef ?? 'latest' }
  if (/(payment|paid|charged)/.test(t)) return { ...base, intent: 'payment_status', order_ref: orderRef ?? 'latest' }
  if (/(my quote|quotation|kotation|accepted my)/.test(t)) return { ...base, intent: 'quote_status', as_role: 'provider', rfq_ref: 'latest' }
  if (/(request|rfq|quotes did|any quotes)/.test(t)) return { ...base, intent: 'rfq_status', rfq_ref: 'latest' }
  if (orderRef) return { ...base, intent: 'order_status', order_ref: orderRef }
  if (/^(hi|hello|hey|namaste|good (morning|evening)|vanakkam|namaskaram)\b/.test(t.trim())) return { ...base, intent: 'greeting' }
  return base
}
