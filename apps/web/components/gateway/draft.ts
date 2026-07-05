import { z } from 'zod'
import { CATEGORY_SLUGS } from '@amclub/shared'

/**
 * Gateway draft profiles (Phase 8a). Written progressively as the visitor
 * answers wizard steps, rehydrated on return, and consumed by the signup
 * wizards as prefill. Keys are versioned; schema-validate on read so a stale
 * or hand-edited value can never crash the gateway (Zod-first, §2.5).
 */

export const BUYER_DRAFT_KEY = 'amc_draft_profile_v1'
export const PROVIDER_DRAFT_KEY = 'amc_provider_draft_v1'
/** sessionStorage — where in the choreography the visitor was (survives the
 *  full-page navigation a locale switch triggers). */
export const GATEWAY_POS_KEY = 'amc_gateway_pos_v1'

/** The 10 launch states offered by the gateway wizard (design handoff). */
export const GATEWAY_STATES = ['AP', 'TS', 'KA', 'TN', 'MH', 'GJ', 'RJ', 'UP', 'DL', 'WB'] as const
export type GatewayState = (typeof GATEWAY_STATES)[number]

const stateSchema = z.enum(GATEWAY_STATES)
const categorySchema = z.enum(CATEGORY_SLUGS)

export const buyerDraftSchema = z
  .object({
    biz: z.enum(['manufacturing', 'trade', 'services']),
    cat: categorySchema,
    band: z.enum(['1-9', '10-49', '50-249']),
    state: stateSchema,
    /** Free-text RFQ note typed on the results screen (carried into signup). */
    note: z.string().max(2000),
  })
  .partial()

export type BuyerDraft = z.infer<typeof buyerDraftSchema>

export const providerDraftSchema = z
  .object({
    cat: categorySchema,
    cred: z.enum(['ca', 'cs', 'adv', 'firm']),
    exp: z.enum(['0-2', '3-9', '10+']),
    state: stateSchema,
  })
  .partial()

export type ProviderDraft = z.infer<typeof providerDraftSchema>

export const gatewayPosSchema = z.object({
  door: z.enum(['msme', 'provider']),
  screen: z.enum(['wizard', 'results', 'apply']),
  step: z.number().int().min(0).max(3).optional(),
})

export type GatewayPos = z.infer<typeof gatewayPosSchema>

function read<T>(storage: Storage, key: string, schema: z.ZodType<T>): T | null {
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function write(storage: Storage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full / privacy mode — the wizard still works, it just forgets.
  }
}

export const loadBuyerDraft = () => read(window.localStorage, BUYER_DRAFT_KEY, buyerDraftSchema)
export const saveBuyerDraft = (d: BuyerDraft) => write(window.localStorage, BUYER_DRAFT_KEY, d)
export const loadProviderDraft = () =>
  read(window.localStorage, PROVIDER_DRAFT_KEY, providerDraftSchema)
export const saveProviderDraft = (d: ProviderDraft) =>
  write(window.localStorage, PROVIDER_DRAFT_KEY, d)
export const loadGatewayPos = () => read(window.sessionStorage, GATEWAY_POS_KEY, gatewayPosSchema)
export const saveGatewayPos = (p: GatewayPos) => write(window.sessionStorage, GATEWAY_POS_KEY, p)
export const clearGatewayPos = () => {
  try {
    window.sessionStorage.removeItem(GATEWAY_POS_KEY)
  } catch {
    /* ignore */
  }
}
