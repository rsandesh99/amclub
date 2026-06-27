import { redirect } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { FileText, Download } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { listMyInvoices } from '@/lib/invoices/queries'
import { formatINR } from '@/lib/format'

// Signed URLs are short-lived → always render fresh.
export const dynamic = 'force-dynamic'

export default async function MsmeInvoicesPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/invoices')
  const t = await getTranslations('invoices')
  const locale = await getLocale()
  const invoices = await listMyInvoices(user.id)

  const dateFmt = new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  })

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
      <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>

      {invoices.length === 0 ? (
        <div className="mt-6 flex flex-col items-center gap-3 rounded-card border border-dashed border-border bg-surface px-6 py-16 text-center">
          <FileText className="h-10 w-10 text-foreground-secondary" />
          <p className="text-sm font-medium">{t('empty_title')}</p>
          <p className="text-sm text-foreground-secondary">{t('empty_subtitle')}</p>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {invoices.map((inv) => (
            <li
              key={inv.id}
              className="flex items-center justify-between gap-4 rounded-card border border-border bg-surface p-4 shadow-card"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{inv.number}</p>
                <Link href={`/app/orders/${inv.orderId}`} className="truncate text-xs text-primary hover:underline">
                  {inv.orderTitle || inv.orderNumber}
                </Link>
                <p className="text-sm text-foreground-secondary">
                  {formatINR(inv.totalPaise)} · {dateFmt.format(new Date(inv.createdAt))}
                </p>
              </div>
              {inv.downloadUrl ? (
                <a
                  href={inv.downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-button border border-border px-3 py-2 text-sm font-medium text-primary hover:bg-primary/5"
                >
                  <Download className="h-4 w-4" />
                  {t('download')}
                </a>
              ) : (
                <span className="shrink-0 text-xs text-foreground-secondary">{t('unavailable')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
