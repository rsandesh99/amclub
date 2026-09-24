import { z } from 'zod'

/**
 * E14 FR-14.5 (N5) — voice search, one language at a time. A language turns on
 * only when (1) ops list it in `agent_settings.voice_search_languages` AND (2)
 * its recorded eval passes: at least 50 real queries in that language, word
 * error rate ≤ 20 % and the right category ≥ 85 % (the E2b bar). Both halves
 * are enforced here and by the route; a missing, stale-version or failing
 * eval keeps the language off whatever the list says.
 */
export const VOICE_SEARCH_LANGUAGES = ['en', 'hi', 'te', 'ta', 'kn', 'mr', 'bn', 'gu', 'ml'] as const
export type VoiceSearchLanguage = (typeof VOICE_SEARCH_LANGUAGES)[number]

export const VOICE_EVAL_VERSION = 'voice-search-eval@v1'
export const VOICE_EVAL_MIN_QUERIES = 50
export const VOICE_EVAL_MAX_WER = 0.2
export const VOICE_EVAL_MIN_CATEGORY_ACCURACY = 0.85

export const voiceLanguageEvalSchema = z.object({
  version: z.string().min(1),
  n: z.number().int().min(0),
  wer: z.number().min(0).max(10),
  categoryAccuracy: z.number().min(0).max(1),
  ranAt: z.string().datetime(),
  set: z.string().max(200).optional(),
})
export type VoiceLanguageEval = z.infer<typeof voiceLanguageEvalSchema>
export const voiceLanguageEvalsSchema = z.record(z.enum(VOICE_SEARCH_LANGUAGES), voiceLanguageEvalSchema)

export function voiceEvalPasses(r: VoiceLanguageEval | null | undefined): boolean {
  return !!r && r.version === VOICE_EVAL_VERSION && r.n >= VOICE_EVAL_MIN_QUERIES && r.wer <= VOICE_EVAL_MAX_WER && r.categoryAccuracy >= VOICE_EVAL_MIN_CATEGORY_ACCURACY
}

/** 'te-IN' / 'TE' → 'te'; anything unrecognised → null. */
export function voiceBaseLanguage(code: string | null | undefined): VoiceSearchLanguage | null {
  const base = (code ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return (VOICE_SEARCH_LANGUAGES as readonly string[]).includes(base) ? (base as VoiceSearchLanguage) : null
}

/** The ONE rule: listed by ops AND its eval passes. */
export function voiceLanguageAllowed(code: string | null | undefined, listed: readonly string[], evals: Partial<Record<string, VoiceLanguageEval>>): boolean {
  const lang = voiceBaseLanguage(code)
  return !!lang && listed.includes(lang) && voiceEvalPasses(evals[lang])
}

/** Lowercase, punctuation out (any script), whitespace collapsed; Indic vowel signs and viramas stay (they are letters' parts). */
export function werTokens(s: string): string[] {
  return s.toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').split(/\s+/).filter(Boolean)
}

/** Word error rate: word-level edit distance / reference length (0 for two empty strings). */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const r = werTokens(reference)
  const h = werTokens(hypothesis)
  if (r.length === 0) return h.length === 0 ? 0 : 1
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j)
  for (let i = 1; i <= r.length; i++) {
    const cur = [i]
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[h.length]! / r.length
}

/** Aggregate one run: WER over all words (not a mean of per-query rates) + category accuracy. */
export function summariseVoiceEval(cases: { reference: string; hypothesis: string; expectedCategory: string | null; gotCategory: string | null }[], at: Date, set?: string): VoiceLanguageEval {
  let edits = 0
  let words = 0
  let right = 0
  let scored = 0
  for (const c of cases) {
    const n = werTokens(c.reference).length
    edits += wordErrorRate(c.reference, c.hypothesis) * n
    words += n
    if (c.expectedCategory) { scored++; if (c.gotCategory === c.expectedCategory) right++ }
  }
  return { version: VOICE_EVAL_VERSION, n: cases.length, wer: words ? Math.round((edits / words) * 1000) / 1000 : 0, categoryAccuracy: scored ? Math.round((right / scored) * 1000) / 1000 : 0, ranAt: at.toISOString(), ...(set ? { set } : {}) }
}
