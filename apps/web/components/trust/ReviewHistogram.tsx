import { useTranslations } from 'next-intl'

/** N13 — five bars (5★ → 1★), counts in tabular numerals; a table for screen readers. */
export function ReviewHistogram({ histogram, total }: { histogram: [number, number, number, number, number]; total: number }) {
  const t = useTranslations('trust')
  if (total === 0) return null
  return (
    <table className="w-full max-w-sm border-collapse text-left">
      <caption className="sr-only">{t('histogram_caption', { total })}</caption>
      <tbody>
        {histogram.map((n, i) => (
          <tr key={i}>
            <th scope="row" className="t-footnote w-10 py-0.5 pr-2 font-normal text-foreground-secondary">{5 - i}★</th>
            <td className="py-0.5">
              <div className="h-2 rounded-chip bg-foreground/10" aria-hidden>
                <div className="h-2 rounded-chip bg-accent" style={{ width: `${Math.round((n / total) * 100)}%` }} />
              </div>
            </td>
            <td className="t-footnote w-10 py-0.5 pl-2 text-right tabular-nums text-foreground-secondary">{n}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
