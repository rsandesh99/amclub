/**
 * "Why AMClub" (E18) — what the product does for a buyer and for a provider,
 * one line each. Every item names a feature that exists in this codebase and
 * is worded to what the code does (docs/prd/PRD_EXPERIENCE_V3.md §E18 lists the
 * evidence per item; re-check it when a rule behind an item changes); copy lives
 * in `why_amclub.<audience>.<key>`. `ai` marks an assistant capability that
 * reaches accounts in stages; `mart` items show only with MART_ENABLED.
 */
export type UspIcon =
  | 'phoneOff' | 'mic' | 'scroll' | 'inbox' | 'columns' | 'lock' | 'badgeCheck' | 'receipt'
  | 'rupee' | 'scale' | 'languages' | 'message' | 'package' | 'target' | 'users' | 'wallet'
  | 'notebook' | 'camera' | 'star' | 'bell' | 'clock'

export interface UspItem { key: string; icon: UspIcon; ai?: boolean; mart?: boolean }

export const BUYER_USPS: readonly UspItem[] = [
  { key: 'no_spam', icon: 'phoneOff' },
  { key: 'voice', icon: 'mic' },
  { key: 'prefill', icon: 'scroll' },
  { key: 'seven_quotes', icon: 'inbox' },
  { key: 'compare', icon: 'columns' },
  { key: 'escrow', icon: 'lock' },
  { key: 'verified', icon: 'badgeCheck' },
  { key: 'gst_invoice', icon: 'receipt' },
  { key: 'fixed_prices', icon: 'rupee' },
  { key: 'disputes', icon: 'scale' },
  { key: 'languages', icon: 'languages' },
  { key: 'mart', icon: 'package', mart: true },
]

export const PROVIDER_USPS: readonly UspItem[] = [
  { key: 'real_buyers', icon: 'target' },
  { key: 'few_competitors', icon: 'users' },
  { key: 'no_fee', icon: 'rupee' },
  { key: 'paid_upfront', icon: 'wallet' },
  { key: 'auto_accept', icon: 'clock' },
  { key: 'clear_briefs', icon: 'scroll' },
  { key: 'no_cold_calls', icon: 'phoneOff' },
  { key: 'munshi', icon: 'notebook', ai: true },
  { key: 'quote_by_voice', icon: 'mic', ai: true },
  { key: 'translate', icon: 'languages', ai: true },
  { key: 'reputation', icon: 'star' },
  { key: 'paperwork', icon: 'receipt' },
  { key: 'sell_goods', icon: 'package', mart: true },
]

export function uspsFor(audience: 'buyers' | 'providers', martEnabled: boolean): readonly UspItem[] {
  const list = audience === 'buyers' ? BUYER_USPS : PROVIDER_USPS
  return martEnabled ? list : list.filter((i) => !i.mart)
}
