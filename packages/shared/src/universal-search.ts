import { z } from 'zod'

/**
 * N3 — universal search (`GET /api/v1/search/universal?q=`): one query over
 * services, providers and categories for everyone, plus the viewer's own
 * requirements, orders and invoices when signed in. Powers ⌘K (desktop) and
 * the search sheet (mobile). Money is never computed here — service hits carry
 * the server's price in paise, rendered as-is.
 */
export const universalSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(80),
})

const hit = z.object({ id: z.string(), title: z.string(), subtitle: z.string().nullable(), href: z.string() })
export type UniversalHit = z.infer<typeof hit>

export const universalSearchResultSchema = z.object({
  q: z.string(),
  services: z.array(hit.extend({ pricePaise: z.number().int().nullable() })),
  providers: z.array(hit),
  categories: z.array(hit),
  mine: z
    .object({
      requirements: z.array(hit),
      orders: z.array(hit),
      invoices: z.array(hit),
    })
    .nullable(),
})
export type UniversalSearchResult = z.infer<typeof universalSearchResultSchema>

/** Escape LIKE wildcards so a user's "%" or "_" matches literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}
