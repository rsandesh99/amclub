import { onboardingCategoryName, onboardingCopy, type OnboardingDraft, type OnboardingLocale } from '@amclub/shared'

/**
 * The WhatsApp summary of a VALIDATED draft (S1.6). Pure: renders from the
 * schema-checked draft only (never model prose beyond the fields), money as
 * ₹ from paise, "not stated" for nulls, chunked to ≤ 1024 characters per
 * message (Meta's text body limit is 4096; 1024 keeps it readable).
 */

export const WA_TEXT_CHUNK = 1024

const LANG_NAMES: Record<string, Record<OnboardingLocale, string>> = {
  en: { en: 'English', hi: 'अंग्रेज़ी', te: 'ఇంగ్లీష్' },
  hi: { en: 'Hindi', hi: 'हिंदी', te: 'హిందీ' },
  te: { en: 'Telugu', hi: 'तेलुगु', te: 'తెలుగు' },
}

export function formatPaiseINR(paise: number): string {
  const rupees = Math.round(paise) / 100
  const whole = Number.isInteger(rupees)
  return `₹${new Intl.NumberFormat('en-IN', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(rupees)}`
}

/** Split on line boundaries so no chunk exceeds `max` characters. */
export function chunkText(text: string, max = WA_TEXT_CHUNK): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let cur = ''
  for (const line of text.split('\n')) {
    const piece = line.length > max ? line.slice(0, max) : line
    if (cur.length + piece.length + 1 > max && cur) {
      out.push(cur)
      cur = piece
    } else {
      cur = cur ? `${cur}\n${piece}` : piece
    }
  }
  if (cur) out.push(cur)
  return out
}

export function renderDraftSummary(draft: OnboardingDraft, locale: OnboardingLocale): string[] {
  const ns = onboardingCopy('not_stated', locale)
  const p = draft.profile
  const lines: string[] = [
    onboardingCopy('draft_intro', locale),
    onboardingCopy('summary_profile', locale, {
      display_name: p.display_name ?? ns,
      legal_name: p.legal_name ?? ns,
      city: p.city ?? ns,
      state: p.state ?? ns,
      languages: p.languages.length ? p.languages.map((l) => LANG_NAMES[l]?.[locale] ?? l).join(', ') : ns,
      categories: p.category_slugs.length ? p.category_slugs.map((s) => onboardingCategoryName(s, locale)).join(', ') : ns,
      about: p.about ?? ns,
    }),
  ]
  draft.packages.forEach((pkg, i) => {
    lines.push(
      onboardingCopy('summary_package', locale, {
        n: i + 1,
        title: pkg.title,
        category: onboardingCategoryName(pkg.category_slug, locale),
        scope: pkg.scope_included.join('; '),
        deliverables: pkg.deliverables.join('; '),
      }),
      onboardingCopy('summary_price', locale, { price: pkg.price_paise === null ? ns : formatPaiseINR(pkg.price_paise) }),
      onboardingCopy('summary_delivery', locale, { days: pkg.delivery_days === null ? ns : onboardingCopy('days_n', locale, { n: pkg.delivery_days }) }),
    )
  })
  if (draft.uncertain_fields.length) lines.push(onboardingCopy('draft_uncertain', locale, { fields: draft.uncertain_fields.join(', ') }))
  return chunkText(lines.join('\n\n'))
}
