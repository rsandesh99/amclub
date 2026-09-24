import 'server-only'
import { goodsReturnDeadline, type OrderStatus } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import type { OrderDetail } from '@/lib/orders/queries'
import { getGoodsDossier, goodsReturnFacts, orderReturnable } from './release'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * Facts the goods order workspace needs beyond the order row: the per-
 * category return window (for the real "returns open until" date), the
 * payout row (for "you receive ₹X after <date>"), and the seller identity
 * for "Order again". Only ever called for kind='goods' orders.
 */
export interface GoodsOrderExtras {
  returnWindowHours: number
  /** When the category return window ends (release gate; ISO), null before delivery evidence. */
  returnWindowEndsAt: string | null
  /**
   * Audit M14 — a completed order's last moment to open a return (ISO; the earlier of
   * the category window and the dispute window). Null when not completed. Clients hide
   * the action once it has passed; they never compute it.
   */
  returnDeadline: string | null
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
  const [dossier, returnable, { data: payout }, { data: seller }] = await Promise.all([
    getGoodsDossier(admin, order),
    orderReturnable(admin, order),
    viewerRole === 'provider'
      ? admin.from('payouts').select('status, scheduled_for, amount_paise').eq('order_id', order.id).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from('provider_profiles').select('display_name, slug').eq('id', order.provider_id).maybeSingle(),
  ])
  const facts = await goodsReturnFacts(admin, order, dossier)
  return {
    returnWindowHours: dossier.returnWindowHours,
    returnWindowEndsAt: dossier.gate.returnWindowEndsAt ? dossier.gate.returnWindowEndsAt.toISOString() : null,
    returnDeadline: goodsReturnDeadline({ status: order.status as OrderStatus, ...facts }),
    returnable,
    payout: payout ? { status: payout.status, scheduledFor: payout.scheduled_for ?? null, amountPaise: Number(payout.amount_paise) } : null,
    sellerName: seller?.display_name ?? '',
    sellerSlug: seller?.slug ?? '',
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
