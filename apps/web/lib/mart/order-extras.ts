import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
import type { OrderDetail } from '@/lib/orders/queries'
import { orderReturnable, returnWindowHoursForOrder } from './release'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * Facts the goods order workspace needs beyond the order row: the per-
 * category return window (for the real "returns open until" date), the
 * payout row (for "you receive ₹X after <date>"), and the seller identity
 * for "Order again". Only ever called for kind='goods' orders.
 */
export interface GoodsOrderExtras {
  returnWindowHours: number
  /** E16 N43 — false: only damaged / wrong / short claims can be opened. */
  returnable: boolean
  /** The seller's payout: only for the seller. Always null for the buyer (audit L8). */
  payout: { status: string; scheduledFor: string | null; amountPaise: number } | null
  sellerName: string
  sellerSlug: string
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `viewerRole` is getOrderDetail's: the payout (the seller's net take, its status —
 * a hold hints at a dispute, a suspension or an unverified bank — and its date) is
 * read only for the provider, mirroring the services gate in lib/orders/queries.ts.
 */
export async function getGoodsOrderExtras(admin: Admin, order: any, viewerRole: OrderDetail['viewerRole']): Promise<GoodsOrderExtras> {
  const [returnWindowHours, returnable, { data: payout }, { data: seller }] = await Promise.all([
    returnWindowHoursForOrder(admin, order),
    orderReturnable(admin, order),
    viewerRole === 'provider'
      ? admin.from('payouts').select('status, scheduled_for, amount_paise').eq('order_id', order.id).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from('provider_profiles').select('display_name, slug').eq('id', order.provider_id).maybeSingle(),
  ])
  return {
    returnWindowHours,
    returnable,
    payout: payout ? { status: payout.status, scheduledFor: payout.scheduled_for ?? null, amountPaise: Number(payout.amount_paise) } : null,
    sellerName: seller?.display_name ?? '',
    sellerSlug: seller?.slug ?? '',
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
