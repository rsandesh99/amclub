import { z } from 'zod'

/**
 * `rfq_parse@v1` / `@v2` (S1.8 §1 — the Phase 8b parser moved into the
 * registry, behaviour preserved). The CONTRACT is `voiceParseSchema` in
 * @amclub/shared (the route reply, `rfqs.voice_meta`, the golden eval). The
 * model itself never emits `original_language` (the STT vendor does), and a
 * hedged reply may omit a field, so the gateway validates this tolerant
 * model-output shape and the parser's `sanitize()` — unchanged from Phase 8b —
 * clamps it into `voiceParseSchema` (vocabulary, state codes, the inverse
 * clamp on `uncertain`). Nothing reaches the client without that clamp.
 */
export const rfqParseModelOutputSchema = z
  .object({
    category_slug: z.string().max(80).nullable().optional(),
    specialization: z.string().max(80).nullable().optional(),
    state: z.string().max(8).nullable().optional(),
    description_english: z.string().max(4000).optional(),
    uncertain: z.boolean().optional(),
  })
  .passthrough()
export type RfqParseModelOutput = z.infer<typeof rfqParseModelOutputSchema>

export { voiceParseSchema, type VoiceParse } from '@amclub/shared'
