import type { WaPricing } from './types'

/**
 * ADR-030 §3 / audit B7 — what one WhatsApp message cost, in MILLIPAISE (1/1000 paise; rule 6: integers only), from
 * Meta's per-message pricing object on the status webhook and the rate registry `agent_settings.wa_rate_millipaise`
 * (list price per message excl. GST, per pricing category). A message Meta marks non-billable (the free service
 * tier, a free entry point) costs 0; an unknown category costs null (recorded, not guessed).
 */

/** Launch rates, excl. 18 % GST: utility / authentication / service ₹0.115, marketing ₹0.8631 (India, Oct 2026). */
export const DEFAULT_WA_RATE_MILLIPAISE: Readonly<Record<string, number>> = {
  utility: 11_500,
  marketing: 86_310,
  authentication: 11_500,
  service: 11_500,
}

export function waMessageCostMillipaise(pricing: WaPricing | null | undefined, rates: Readonly<Record<string, number>> = DEFAULT_WA_RATE_MILLIPAISE): number | null {
  if (!pricing) return null
  if (pricing.billable === false) return 0
  if (pricing.type && pricing.type.startsWith('free')) return 0
  const cat = (pricing.category ?? '').toLowerCase()
  const rate = rates[cat]
  return typeof rate === 'number' && Number.isInteger(rate) && rate >= 0 ? rate : null
}
