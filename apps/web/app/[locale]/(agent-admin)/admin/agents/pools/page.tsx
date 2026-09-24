import { getTranslations } from 'next-intl/server'
import { agentPageGate } from '@/lib/agent/gate'
import { createAdminClient } from '@/lib/supabase/server'
import { adminPools } from '@/lib/pools/queries'
import { istShort, stateLabel } from '@/lib/pools/labels'
import { AdminPoolsClient } from '@/components/pools/AdminPoolsClient'

export const dynamic = 'force-dynamic'

/**
 * /admin/agents/pools (S3.4, ADR 024) — every group request with its counts, including each closed group's
 * committed → quoted → paid numbers (the honest-commitment measure). The admin layout requires the admin / ops role.
 */
export default async function AdminPoolsPage() {
  agentPageGate()
  const admin = await createAdminClient()
  const pools = await adminPools(admin)
  const tSvc = await getTranslations('services')
  return (
    <AdminPoolsClient
      rows={pools.map((p) => ({
        id: p.id,
        service: tSvc.has(p.service_slug as 'gst-filing') ? tSvc(p.service_slug as 'gst-filing') : p.service_slug,
        state: stateLabel(p.state),
        status: p.status,
        joined: p.joined,
        invited: p.invited,
        offers: p.offers,
        quoted: p.quoted,
        paid: p.paid,
        closes: istShort(p.closes_at ?? p.form_by) ?? '',
      }))}
    />
  )
}
