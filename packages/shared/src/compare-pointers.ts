import { z } from 'zod'
import { uuidSchema } from './schemas/index'

/**
 * Compare pointers (S1.2): up to three one-sentence lines per quote, in the
 * buyer's language, that RESTATE the deterministic flags as consequences. The
 * schema has no rank, no recommendation, no "best" field, and is `.strict()`
 * so an extra key is rejected outright. A banned-phrase gate runs at eval time
 * AND at runtime (COMPARE_BANNED_PHRASES); a hit drops that quote's lines.
 */

export const POINTER_LOCALES = ['en', 'hi', 'ta', 'te'] as const
export type PointerLocale = (typeof POINTER_LOCALES)[number]
export const pointerLocaleSchema = z.enum(POINTER_LOCALES)

export const comparePointersSchema = z
  .object({
    pointers: z
      .array(
        z
          .object({
            quote_id: uuidSchema,
            lines: z.array(z.string().min(1).max(160)).max(3),
          })
          .strict(),
      )
      .max(7),
  })
  .strict()
export type ComparePointers = z.infer<typeof comparePointersSchema>

/** Words that rank or recommend. Matched case-insensitively as substrings; one hit drops the quote's lines. */
export const COMPARE_BANNED_PHRASES: Record<PointerLocale, readonly string[]> = {
  en: ['best', 'cheapest overall', 'choose', 'go with', 'avoid', 'recommend', 'you should', 'pick this', 'winner', 'worst', 'better than', 'safest bet'],
  hi: ['सबसे अच्छा', 'सबसे बेहतर', 'चुनें', 'चुनना चाहिए', 'बचें', 'सिफारिश', 'सबसे सस्ता कुल', 'विजेता', 'सबसे बुरा', 'best', 'choose', 'avoid', 'recommend'],
  ta: ['சிறந்த', 'தேர்வு செய்', 'தவிர்', 'பரிந்துரை', 'மிகச் சிறந்த', 'best', 'choose', 'avoid', 'recommend'],
  te: ['ఉత్తమ', 'ఎంచుకో', 'నివారించ', 'సిఫార్సు', 'అత్యుత్తమ', 'best', 'choose', 'avoid', 'recommend'],
}

/**
 * S2.4 — pointers never talk about the ORDER the quotes are shown in, nor any score (the reliability ordering is
 * the server's fixed line, ADR-010 §7). Pointer-only: kept out of the shared RANKING_PHRASES, which other outputs
 * (the provider's own coaching note) must stay free to use words like "score".
 */
export const COMPARE_ORDERING_PHRASES: Record<PointerLocale, readonly string[]> = {
  en: ['listed first', 'shown first', 'ordered by', 'ranked', 'reliability', 'amc score', 'score'],
  hi: ['पहले दिखाया', 'सबसे ऊपर दिखाया', 'क्रम में', 'विश्वसनीयता', 'स्कोर'],
  ta: ['முதலில் காட்டப்பட்ட', 'வரிசைப்படுத்தப்பட்ட', 'நம்பகத்தன்மை', 'மதிப்பெண்'],
  te: ['ముందుగా చూపబడింది', 'క్రమంలో', 'విశ్వసనీయత', 'స్కోర్'],
}

/** The banned phrases found in `text` for `locale` (ranking + ordering; empty = clean). */
export function findBannedPhrases(text: string, locale: PointerLocale): string[] {
  const hay = text.toLowerCase()
  return [...COMPARE_BANNED_PHRASES[locale], ...COMPARE_ORDERING_PHRASES[locale]].filter((p) => hay.includes(p.toLowerCase()))
}

/** Drop every quote's lines that contain a banned phrase; returns the cleaned object + which quote ids were dropped. */
export function sanitizePointers(p: ComparePointers, locale: PointerLocale): { pointers: ComparePointers; dropped: string[] } {
  const dropped: string[] = []
  const pointers: ComparePointers = {
    pointers: p.pointers.map((q) => {
      const hit = q.lines.some((l) => findBannedPhrases(l, locale).length > 0)
      if (hit) dropped.push(q.quote_id)
      return hit ? { quote_id: q.quote_id, lines: [] } : q
    }),
  }
  return { pointers, dropped }
}

/** The cached shape stored in rfqs.compare_pointers (one slot per RFQ). */
export const comparePointersCacheSchema = z.object({
  hash: z.string().min(8).max(128),
  locale: pointerLocaleSchema,
  pointers: comparePointersSchema.shape.pointers,
  model: z.string().nullable(),
  stub: z.boolean(),
  created_at: z.string(),
})
export type ComparePointersCache = z.infer<typeof comparePointersCacheSchema>
