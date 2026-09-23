import { z } from 'zod'

/**
 * E14 FR-14.3 (N32b, dark) — a provider's own catalogue copy in Hindi, Telugu
 * and Tamil. A model DRAFTS (`provider_content_translate@v1`); the provider
 * approves each language side by side in Listings; only an approved text is
 * written into the i18n map (source `machine_approved`, one `ai_decisions` row,
 * feature `content_translation`). A draft lives in `content_translations` and
 * never renders. Numbers are copied, never translated: a translation must carry
 * exactly the source's digit runs. Gate: AGENT_ENABLED +
 * agents_enabled.content_translate + the cohort.
 */
export const CONTENT_TRANSLATE_LANGS = ['hi', 'te', 'ta'] as const
export type ContentTranslateLang = (typeof CONTENT_TRANSLATE_LANGS)[number]

/** What can be translated: a package's title and "Choose this if…" line, and the profile's About. */
export const CONTENT_TRANSLATE_FIELDS = { package: ['title', 'ideal_for'], profile: ['about'] } as const
export type ContentSubjectKind = keyof typeof CONTENT_TRANSLATE_FIELDS
export type ContentField = (typeof CONTENT_TRANSLATE_FIELDS)[ContentSubjectKind][number]
export const CONTENT_FIELD_MAX: Record<ContentField, number> = { title: 200, ideal_for: 200, about: 1500 }

/** How an i18n slot was filled; only `machine_approved` shows "Translated · View original". */
export const CONTENT_SOURCES = ['provider', 'machine_approved'] as const
export type ContentSource = (typeof CONTENT_SOURCES)[number]
/** `{ title: { te: 'machine_approved' } }` beside the entity's i18n maps. */
export type I18nSources = Partial<Record<ContentField, Partial<Record<ContentTranslateLang, ContentSource>>>>

export const contentTranslateRequestSchema = z.object({
  subjectKind: z.enum(['package', 'profile']),
  subjectId: z.string().uuid().optional(),
  lang: z.enum(CONTENT_TRANSLATE_LANGS),
}).refine((v) => v.subjectKind === 'profile' || !!v.subjectId, { message: 'subjectId required for a package', path: ['subjectId'] })
export type ContentTranslateRequest = z.infer<typeof contentTranslateRequestSchema>

export const contentTranslationApproveSchema = z.object({
  /** The provider's edit of the draft; absent = approve the draft as written. */
  text: z.string().trim().min(1).max(1500).optional(),
})

/** The model's output: one translated string. The customer-facing contract is applied in agent-core. */
export const contentTranslationOutputSchema = z.object({ text: z.string().trim().min(1).max(1500) })
export type ContentTranslationOutput = z.infer<typeof contentTranslationOutputSchema>

export const contentTranslationViewSchema = z.object({
  id: z.string().uuid(),
  subjectKind: z.enum(['package', 'profile']),
  subjectId: z.string().uuid(),
  field: z.enum(['title', 'ideal_for', 'about']),
  lang: z.enum(CONTENT_TRANSLATE_LANGS),
  sourceText: z.string(),
  draftText: z.string(),
  status: z.enum(['draft', 'approved', 'rejected', 'stale']),
})
export type ContentTranslationView = z.infer<typeof contentTranslationViewSchema>

const DIGIT_RUNS = /[0-9०-९౦-౯௦-௯]+(?:[.,][0-9०-९౦-౯௦-௯]+)*/g
const INDIC_DIGIT = /[०-९౦-౯௦-௯]/

/**
 * Numbers are copied, never translated (FR-14.3, D-PRD7): the translation's
 * digit runs must equal the source's (as a multiset, Latin digits only). Returns
 * the problems; empty = fine.
 */
export function contentNumbersProblems(source: string, translation: string): string[] {
  const problems: string[] = []
  if (INDIC_DIGIT.test(translation)) problems.push('native_digits')
  const runs = (s: string) => (s.match(DIGIT_RUNS) ?? []).sort()
  const a = runs(source)
  const b = runs(translation)
  if (a.join('|') !== b.join('|')) problems.push(`numbers_changed:${a.join(',')}→${b.join(',')}`)
  return problems
}

/** Whether a translated slot shows "Translated · View original". */
export function isMachineTranslated(sources: I18nSources | null | undefined, field: ContentField, locale: string): boolean {
  return (CONTENT_TRANSLATE_LANGS as readonly string[]).includes(locale) && sources?.[field]?.[locale as ContentTranslateLang] === 'machine_approved'
}
