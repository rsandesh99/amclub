import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { ClipboardList } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { listMyRfqs } from '@/lib/rfq/queries'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  open: 'info', quoted: 'warning', accepted: 'success', expired: 'default', cancelled: 'default',
}

export default async function MyRfqsPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/rfq')
  const t = await getTranslations('rfq')
  const rfqs = await listMyRfqs(user.id)

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">{t('list_title')}</h1>
          <p className="mt-1 text-sm text-foreground-secondary">{t('list_subtitle')}</p>
        </div>
        <Link href="/app/rfq/new"><Button>{t('post_cta')}</Button></Link>
      </div>

      {rfqs.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border bg-surface px-6 py-16 text-center">
          <ClipboardList className="h-10 w-10 text-foreground-secondary" />
          <p className="text-sm font-medium">{t('no_rfqs_title')}</p>
          <p className="text-sm text-foreground-secondary">{t('no_rfqs_body')}</p>
          <Link href="/app/rfq/new"><Button variant="secondary" className="mt-2">{t('post_cta')}</Button></Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {rfqs.map((r) => (
            <li key={r.id}>
              <Link href={`/app/rfq/${r.id}`} className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 shadow-card hover:border-primary/40">
                <div className="min-w-0">
                  <p className="truncate font-medium">{r.title}</p>
                  <p className="text-xs text-foreground-secondary">{t('quotes_n', { n: r.quoteCount, max: r.maxQuotes })}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  {r.kind === 'goods' && <Badge variant="default">{t('goods_badge')}</Badge>}
                  {/* S1.3 — derived badge: unanswered provider questions (never a status). */}
                  {r.openQuestions > 0 && (r.status === 'open' || r.status === 'quoted') && <Badge variant="warning">{t('clarify_waiting_badge', { n: r.openQuestions })}</Badge>}
                  <Badge variant={VARIANT[r.status] ?? 'default'}>{t(`status_${r.status}` as 'status_open')}</Badge>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
