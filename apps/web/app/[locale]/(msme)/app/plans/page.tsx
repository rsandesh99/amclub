import { notFound, redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { isUnstartedChild } from '@amclub/shared'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { bundlesOn, plansForBuyer } from '@/lib/bundles'
import { PlansClient, type PlanCard } from './PlansClient'

export const dynamic = 'force-dynamic'

/** Statuses after which a milestone's money is no longer held for the buyer (released, refunded or cancelled). */
const SETTLED = new Set(['completed', 'reviewed', 'refunded', 'cancelled_by_buyer', 'auto_cancelled', 'cancelled_duplicate', 'resolved_refund', 'resolved_release', 'resolved_partial'])

/**
 * E12c / ADR 021 — the buyer's plans: each milestone as its own order on a
 * timeline, the next one due, the money still held, and "Cancel remaining"
 * (unstarted milestones back in full). Every figure is computed here, on the
 * server. 404 while `bundles_enabled` is off.
 */
export default async function PlansPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/plans')
  const admin = await createAdminClient()
  if (!(await bundlesOn(admin))) notFound()
  const t = await getTranslations('plans')
  const locale = await getLocale()
  const { data: msme } = await admin.from('msme_profiles').select('id').eq('user_id', user.id).maybeSingle()
  const plans = msme ? await plansForBuyer(admin, msme.id as string) : []
  const date = new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })

  const cards: PlanCard[] = plans.map((p) => {
    const open = p.children.filter((c) => !SETTLED.has(c.status))
    const next = open[0] ?? null
    return {
      id: p.id,
      title: p.title,
      purchasedOn: date.format(new Date(p.createdAt)),
      totalPaise: p.totalPaise,
      heldPaise: open.reduce((s, c) => s + c.totalPaise, 0),
      next: next ? { seq: next.seq, due: next.dueAt ? date.format(new Date(next.dueAt)) : null } : null,
      remaining: p.children.filter((c) => isUnstartedChild(c.status)).length,
      children: p.children.map((c) => ({ id: c.id, seq: c.seq, title: c.title, status: c.status, totalPaise: c.totalPaise, due: c.dueAt ? date.format(new Date(c.dueAt)) : null, starts: c.availableAt ? date.format(new Date(c.availableAt)) : null })),
    }
  })

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
      <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>
      <PlansClient plans={cards} />
    </div>
  )
}
