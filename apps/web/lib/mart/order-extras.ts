import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
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
  payout: { status: string; scheduledFor: string | null; amountPaise: number } | null
  sellerName: string
  sellerSlug: string
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function getGoodsOrderExtras(admin: Admin, order: any): Promise<GoodsOrderExtras> {
  const [returnWindowHours, returnable, { data: payout }, { data: seller }] = await Promise.all([
    returnWindowHoursForOrder(admin, order),
    orderReturnable(admin, order),
    admin.from('payouts').select('status, scheduled_for, amount_paise').eq('order_id', order.id).maybeSingle(),
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
