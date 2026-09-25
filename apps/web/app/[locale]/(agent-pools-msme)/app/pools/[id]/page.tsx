import { notFound, redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { poolBuyerView } from '@/lib/pools/queries'
import { istDate, istShort, stateLabel } from '@/lib/pools/labels'
import { PoolBuyerClient } from '@/components/pools/PoolBuyerClient'

export const dynamic = 'force-dynamic'

/** S3.4 (ADR 024, dark) — a member's view of one group request: the count, the offers, one choice. */
export default async function BuyerPoolPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getSessionUser()
  if (!user) redirect(`/login?next=/app/pools/${id}`)
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, user.id)
  if (!actor.msmeId || !/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const locale = await getLocale()
  const view = await poolBuyerView(admin, id, actor.msmeId, locale)
  if (!view) notFound()
  const tSvc = await getTranslations('services')
  const service = tSvc.has(view.serviceSlug as 'gst-filing') ? tSvc(view.serviceSlug as 'gst-filing') : view.categoryName
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <PoolBuyerClient
        view={view}
        labels={{
          service,
          state: stateLabel(view.state, locale),
          closesAt: istShort(view.closesAt),
          formBy: istShort(view.formBy) ?? '',
          validUntil: Object.fromEntries(view.offers.map((o) => [o.id, istDate(o.validUntil)])),
        }}
      />
    </div>
  )
}
