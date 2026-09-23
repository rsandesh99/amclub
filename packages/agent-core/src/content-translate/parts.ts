import { CONTENT_FIELD_MAX, contentNumbersProblems, type ContentField, type ContentTranslateLang, type ContentTranslationOutput } from '@amclub/shared'
import type { ChatParts } from '../llm/gateway'
import { envelope } from '../untrusted/envelope'

/**
 * E14 FR-14.3 — `provider_content_translate@v1` parts. TRUSTED: the target
 * language, the field kind and its length cap. UNTRUSTED: the provider's
 * English text, enveloped (kind `provider_content_<field>`, capped). Nothing
 * else reaches the prompt.
 */
export interface ContentTranslateInput {
  subjectId: string
  field: ContentField
  lang: ContentTranslateLang
  source: string
}

const LANG_NAME: Record<ContentTranslateLang, string> = { hi: 'Hindi (hi)', te: 'Telugu (te)', ta: 'Tamil (ta)' }
const FIELD_KIND: Record<ContentField, string> = {
  title: 'a package title (a short name for the service)',
  ideal_for: 'the package\'s "Choose this if…" line (one line)',
  about: 'the provider profile\'s About (a short paragraph)',
}

export function buildContentTranslateParts(input: ContentTranslateInput): ChatParts {
  return {
    trusted: [
      `target language: ${LANG_NAME[input.lang]}`,
      `field: ${FIELD_KIND[input.field]}`,
      `max characters: ${CONTENT_FIELD_MAX[input.field]}`,
    ],
    untrusted: [envelope(input.source, { kind: `provider_content_${input.field}`, id: input.subjectId })],
  }
}

/** The script each target language is written in (a translation must use it). */
const SCRIPT: Record<ContentTranslateLang, RegExp> = { hi: /[ऀ-ॿ]/, te: /[ఀ-౿]/, ta: /[஀-௿]/ }

/**
 * Everything code checks on an output beyond the schema: the numbers rule, the
 * field's length cap and — for a real model output — the target script.
 * Empty = acceptable as a draft.
 */
export function contentTranslationProblems(input: ContentTranslateInput, out: ContentTranslationOutput, opts: { stub: boolean }): string[] {
  const problems = contentNumbersProblems(input.source, out.text)
  if (out.text.length > CONTENT_FIELD_MAX[input.field]) problems.push('too_long')
  if (!opts.stub && /\p{L}/u.test(input.source) && !SCRIPT[input.lang].test(out.text)) problems.push('wrong_script')
  return problems
}

/** Keyless stub: the source unchanged (a stub draft is visibly English — the provider edits or discards it). */
export function stubContentTranslation(input: ContentTranslateInput): ContentTranslationOutput {
  return { text: input.source.slice(0, CONTENT_FIELD_MAX[input.field]) }
}
