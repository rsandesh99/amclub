import { martPageGate } from '@/lib/mart/gate'
import { MartAdminClient } from './MartAdminClient'

/**
 * AMC Mart admin (S2.3 dark build). Flag-gated exactly like /admin/coupons:
 * while MART_ENABLED is OFF the page 404s and the nav tab is removed — the
 * listing-approval queue + goods-orders list below stay in the repo, dormant.
 */
export default function AdminMartPage() {
  martPageGate()
  return <MartAdminClient />
}
