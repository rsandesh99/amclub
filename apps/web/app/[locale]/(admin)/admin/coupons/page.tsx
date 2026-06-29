import { notFound } from 'next/navigation'
import { COUPONS_ENABLED } from '@/lib/flags'
import { CouponsClient } from './CouponsClient'

/**
 * Coupons admin (A6). Flag-gated: while COUPONS_ENABLED is OFF the page is
 * hidden (404) and the nav tab is removed — the client UI stays in the repo,
 * dormant. Flip COUPONS_ENABLED=true to restore it.
 */
export default function AdminCouponsPage() {
  if (!COUPONS_ENABLED) notFound()
  return <CouponsClient />
}
