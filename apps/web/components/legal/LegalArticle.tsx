import { getTranslations } from 'next-intl/server'

/**
 * Shared renderer for the legal pages (B2 — /terms, /privacy, /refund-policy).
 * Content lives in the `legal` message namespace as `{doc}_s{n}_h` /
 * `{doc}_s{n}_p` pairs so every locale renders through next-intl (§2.5 rule 3).
 * The copy states ACTUAL product behavior (escrow, §3.7 cancellation windows,
 * no-audio-retention) — update it alongside any behavior change, and get
 * counsel review before pilot launch (tracked in STATUS_AUDIT B2).
 */
export async function LegalArticle({ doc, sections }: { doc: 'terms' | 'privacy' | 'refund'; sections: number }) {
  const t = await getTranslations('legal')

  return (
    <article className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="font-display text-3xl font-bold text-foreground">{t(`${doc}_title`)}</h1>
      <p className="mt-2 text-sm text-foreground-secondary">{t('updated', { date: t(`${doc}_updated`) })}</p>
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
      <p className="mt-10 border-t border-border pt-6 text-sm text-foreground-secondary">{t('contact_line')}</p>
    </article>
  )
}
