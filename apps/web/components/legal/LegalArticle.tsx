import { getLocale, getTranslations } from 'next-intl/server'
import type { LegalDoc } from '@amclub/shared'
import { LEGAL_VERSIONS_EFFECTIVE as LEGAL_VERSIONS } from '@/lib/legal/versions'

/**
 * Shared renderer for the legal pages (/terms, /privacy, /refund-policy,
 * /provider-addendum). Content lives in the `legal` message namespace as
 * `{doc}_s{n}_h` / `{doc}_s{n}_p` pairs so every locale renders through
 * next-intl (§2.5 rule 3). The copy states ACTUAL product behavior (escrow,
 * §3.7 cancellation windows, no-audio-retention) — update it alongside any
 * behavior change. DRAFT FOR COUNSEL REVIEW before pilot launch (audit B2).
 *
 * The "last updated" date comes from LEGAL_VERSIONS (single source with the
 * acceptance rows) for versioned docs; the refund policy is not an accepted
 * document and keeps its own `refund_updated` key.
 */
export async function LegalArticle({
  doc,
  sections,
  children,
}: {
  doc: LegalDoc | 'refund'
  sections: number
  /** Optional block rendered after the sections (e.g. the grievance officer). */
  children?: React.ReactNode
}) {
  const t = await getTranslations('legal')
  const locale = await getLocale()
  const updated =
    doc === 'refund'
      ? t('refund_updated')
      : new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(`${LEGAL_VERSIONS[doc]}T00:00:00Z`))

  return (
    <article className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="font-display text-3xl font-bold text-foreground">{t(`${doc}_title`)}</h1>
      <p className="mt-2 text-sm text-foreground-secondary">{t('updated', { date: updated })}</p>
      <div className="mt-8 space-y-8">
        {Array.from({ length: sections }, (_, i) => i + 1).map((n) => (
          <section key={n}>
            <h2 className="text-lg font-semibold text-foreground">
              {n}. {t(`${doc}_s${n}_h`)}
            </h2>
            <p className="mt-2 text-[15px] leading-relaxed text-foreground-secondary [text-wrap:pretty]">
              {t(`${doc}_s${n}_p`)}
            </p>
          </section>
        ))}
      </div>
      {children && <div className="mt-10">{children}</div>}
      <p className="mt-10 border-t border-border pt-6 text-sm text-foreground-secondary">{t('contact_line')}</p>
    </article>
  )
}
