import { z } from 'zod'

/**
 * ADR 020 (E12b) — the quote option input shapes, dependency-free so the quote
 * schema can import them without a cycle. Logic lives in quote-options.ts.
 */
export const QUOTE_OPTION_LABELS = ['economy', 'express'] as const
export type QuoteOptionLabel = (typeof QUOTE_OPTION_LABELS)[number]
/** The labels a buyer can pick, Standard being the quote row. */
export type QuoteChoiceLabel = QuoteOptionLabel | 'standard'
export const MAX_QUOTE_OPTIONS = 2

export const quoteOptionInputSchema = z
  .object({
    label: z.enum(QUOTE_OPTION_LABELS),
    price_paise: z.number().int().positive().max(1_000_000_000_00),
    delivery_days: z.number().int().positive().max(365),
  })
  .strict()
export type QuoteOptionInput = z.infer<typeof quoteOptionInputSchema>

export const quoteOptionsSchema = z
  .array(quoteOptionInputSchema)
  .max(MAX_QUOTE_OPTIONS)
  .refine((xs) => new Set(xs.map((x) => x.label)).size === xs.length, { message: 'duplicate_option' })
