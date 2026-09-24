import { notFound, redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { poolProviderView } from '@/lib/pools/queries'
import { istShort, stateLabel, todayIst } from '@/lib/pools/labels'
import { PoolOfferForm } from '@/components/pools/PoolOfferForm'

export const dynamic = 'force-dynamic'

/** S3.4 (ADR 024, dark) — one group request, seen by an eligible provider: the count, its requests, ONE sealed offer. */
export default async function PartnerPoolPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getSessionUser()
  if (!user) redirect(`/login?next=/partner/pools/${id}`)
  const admin = await createAdminClient()
  const { data: p } = await admin.from('provider_profiles').select('id').eq('user_id', user.id).maybeSingle()
  if (!p) redirect('/partner/onboarding')
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const view = await poolProviderView(admin, id, p.id as string, await getLocale())
  if (!view) notFound()
  const tSvc = await getTranslations('services')
  const today = todayIst()
  const closeDay = view.closesAt ? view.closesAt.slice(0, 10) : today
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <PoolOfferForm
        view={view}
        labels={{
          service: tSvc.has(view.serviceSlug as 'gst-filing') ? tSvc(view.serviceSlug as 'gst-filing') : view.categoryName,
          state: stateLabel(view.state),
          closesAt: istShort(view.closesAt),
          minValidUntil: closeDay > today ? closeDay : today,
        }}
      />
    </div>
  )
}
