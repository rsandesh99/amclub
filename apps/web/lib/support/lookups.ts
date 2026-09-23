import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatRupees, type SupportOrderView, type SupportRfqView } from '@amclub/shared'
import type { SupportLookups } from '@amclub/agent-core'
import { nudgeCapped } from '@/lib/support/nudge'
import { orderIsActive, rfqIsActive } from '@amclub/shared'
import { listMatchedRfqsForProvider, listMyQuotesForProvider } from '@/lib/rfq/queries'

/**
 * S2.3 — the web / mobile lookups: every read runs on the USER'S OWN session
 * client (RLS enforced), never the service role — except payout / refund
 * facts, which are not on any party route: after the session read already
 * proved the order is the user's (RLS returned it), the service role reads
 * the user's own `payouts` / `refunds` row for that order id only.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORDER_COLS = 'id, order_number, title, status, total_paise, provider_earning_paise, due_at, updated_at, msme_id, provider_id'

function istDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}

export function toOrderView(o: any, role: 'buyer' | 'provider', extra: { payout?: SupportOrderView['payout']; refund?: SupportOrderView['refund'] } = {}): SupportOrderView {
  return {
    id: o.id,
    order_number: String(o.order_number ?? o.id),
    title: String(o.title ?? ''),
    status: String(o.status),
    amount: formatRupees(Number(o.total_paise ?? 0)),
    earning: role === 'provider' ? formatRupees(Number(o.provider_earning_paise ?? 0)) : null,
    eta_date: istDate(o.due_at),
    updated_at: String(o.updated_at ?? ''),
    payout: extra.payout ?? null,
    refund: extra.refund ?? null,
  }
}

export function toRfqView(r: any, myQuote: { status: string; price_paise: number } | null): SupportRfqView {
  return {
    id: r.id,
    title: String(r.title ?? ''),
    status: String(r.status),
    quote_count: Number(r.quote_count ?? 0),
    max_quotes: Number(r.max_quotes ?? 7),
    expires_at: istDate(r.expires_at),
    my_quote: myQuote ? { status: myQuote.status, price: formatRupees(myQuote.price_paise) } : null,
  }
}

export interface WebLookupContext {
  /** The user's own session client (RLS). */
  session: SupabaseClient
  /** Service role — used ONLY for payout / refund facts of an order the session already returned, and the nudge cap. */
  admin: SupabaseClient
  userId: string
  msmeId: string | null
  providerId: string | null
}

export function webSupportLookups(ctx: WebLookupContext): SupportLookups {
  const ownOrders = (role: 'buyer' | 'provider') => {
    let q = ctx.session.from('orders').select(ORDER_COLS).is('deleted_at', null).order('created_at', { ascending: false }).limit(10)
    q = role === 'provider' ? q.eq('provider_id', ctx.providerId ?? '00000000-0000-0000-0000-000000000000') : q.eq('msme_id', ctx.msmeId ?? '00000000-0000-0000-0000-000000000000')
    return q
  }
  async function moneyFacts(orderId: string, role: 'buyer' | 'provider'): Promise<{ payout?: SupportOrderView['payout']; refund?: SupportOrderView['refund'] }> {
    const out: { payout?: SupportOrderView['payout']; refund?: SupportOrderView['refund'] } = {}
    try {
      if (role === 'provider') {
        const { data: p } = await ctx.admin.from('payouts').select('status, scheduled_for, amount_paise').eq('order_id', orderId).order('created_at', { ascending: false }).limit(1).maybeSingle()
        if (p) out.payout = { status: String((p as any).status), scheduled_for: istDate((p as any).scheduled_for), amount: (p as any).amount_paise != null ? formatRupees(Number((p as any).amount_paise)) : null }
      } else {
        const { data: pay } = await ctx.admin.from('payments').select('id').eq('order_id', orderId).limit(1).maybeSingle()
        if (pay) {
          const { data: r } = await ctx.admin.from('refunds').select('status').eq('payment_id', (pay as any).id).order('created_at', { ascending: false }).limit(1).maybeSingle()
          if (r) out.refund = { status: String((r as any).status) }
        }
      }
    } catch {
      /* money facts are optional: the template degrades to the order status */
    }
    return out
  }
  return {
    async listOrders(role) {
      const { data } = await ownOrders(role)
      return ((data as any[]) ?? []).map((o) => toOrderView(o, role))
    },
    async getOrder(ref, role) {
      const { data } = await ownOrders(role).ilike('order_number', ref)
      const o = ((data as any[]) ?? [])[0]
      if (!o) return null
      return toOrderView(o, role, await moneyFacts(o.id, role))
    },
    async listRfqs(role) {
      if (role === 'buyer') {
        const { data } = await ctx.session.from('rfqs').select('id, title, status, quote_count, max_quotes, expires_at').eq('msme_id', ctx.msmeId ?? '00000000-0000-0000-0000-000000000000').is('deleted_at', null).order('created_at', { ascending: false }).limit(10)
        return ((data as any[]) ?? []).map((r) => toRfqView(r, null))
      }
      // the provider's screens' own party-scoped loaders (rfqs RLS hides every non-open request from a matched
      // provider, so a session read would lose the quoted / accepted ones): my quotes first (real status + price),
      // then matched requests I have not quoted
      if (!ctx.providerId) return []
      const [mine, matched] = await Promise.all([listMyQuotesForProvider(ctx.userId), listMatchedRfqsForProvider(ctx.userId)])
      const out = new Map<string, SupportRfqView>()
      for (const q of mine) out.set(q.rfqId, toRfqView({ id: q.rfqId, title: q.title, status: q.rfqStatus, quote_count: q.quoteCount, max_quotes: q.maxQuotes, expires_at: q.expiresAt }, { status: q.quoteStatus, price_paise: q.pricePaise }))
      for (const m of matched) if (!out.has(m.rfqId) && !m.declined) out.set(m.rfqId, toRfqView({ id: m.rfqId, title: m.title, status: m.status, quote_count: m.quoteCount, max_quotes: m.maxQuotes, expires_at: m.expiresAt }, null))
      return [...out.values()].slice(0, 10)
    },
    async getRfq(ref, role) {
      const all = await this.listRfqs(role)
      return all.find((r) => r.title.toLowerCase() === ref.toLowerCase()) ?? null
    },
    async nudgeState(subject, role) {
      if (subject.kind === 'order') {
        const { data } = await ownOrders(role).eq('id', subject.id)
        const o = ((data as any[]) ?? [])[0]
        if (!o) return { active: false, capped: true }
        return { active: orderIsActive(String(o.status)), capped: await nudgeCapped(ctx.admin, 'order', subject.id, ctx.userId) }
      }
      const rfqs = await this.listRfqs(role)
      const r = rfqs.find((x) => x.id === subject.id)
      if (!r) return { active: false, capped: true }
      return { active: rfqIsActive(r.status), capped: await nudgeCapped(ctx.admin, 'rfq', subject.id, ctx.userId) }
    },
  }
}
