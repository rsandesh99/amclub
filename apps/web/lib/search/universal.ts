import 'server-only'
import { escapeLike, type UniversalHit, type UniversalSearchResult } from '@amclub/shared'
import { createAdminClient, createPublicClient } from '@/lib/supabase/server'
import { searchPackages } from '@/lib/catalog/queries'
import { resolveActor } from '@/lib/orders/actor'
import { pickI18n, computePricing } from '@/lib/format'

const PER_GROUP = 5

type NameMap = { en: string; hi?: string; te?: string; ta?: string }

/**
 * N3 — universal search. Public groups read through the anon client (the
 * same active-row policies as the catalog, explicit safe columns); "mine" is
 * party-scoped: every read is keyed to the caller's own profile ids.
 */
export async function universalSearch(q: string, userId: string | null, locale: string): Promise<UniversalSearchResult> {
  const pub = createPublicClient()
  const like = `%${escapeLike(q)}%`
  const needle = q.toLowerCase()

  const [catsRes, provRes, pkgs] = await Promise.all([
    pub.from('categories').select('slug, name_i18n').eq('is_active', true),
    pub
      .from('provider_profiles')
      .select('slug, display_name, city, state')
      .eq('status', 'active')
      .is('deleted_at', null)
      .ilike('display_name', like)
      .limit(PER_GROUP),
    searchPackages({ query: q, limit: PER_GROUP }),
  ])

  const categories: UniversalHit[] = (catsRes.data ?? [])
    .filter((c) => Object.values((c.name_i18n ?? {}) as NameMap).some((n) => typeof n === 'string' && n.toLowerCase().includes(needle)))
    .slice(0, PER_GROUP)
    .map((c) => ({ id: c.slug as string, title: pickI18n(c.name_i18n as NameMap, locale), subtitle: null, href: `/services/${c.slug}` }))

  const providers: UniversalHit[] = (provRes.data ?? []).map((p) => ({
    id: p.slug as string,
    title: p.display_name as string,
    subtitle: [p.city, p.state].filter(Boolean).join(', ') || null,
    href: `/p/${p.slug}`,
  }))

  const services = pkgs.results.map((r) => ({
    id: r.packageId,
    title: pickI18n(r.titleI18n, locale),
    subtitle: r.displayName,
    href: `/p/${r.providerSlug}/${r.packageSlug}`,
    // The catalog's own price rule (lib/format computePricing) — never re-derived here.
    pricePaise: computePricing(r).discountedPaise,
  }))

  let mine: UniversalSearchResult['mine'] = null
  if (userId) {
    const admin = await createAdminClient()
    const actor = await resolveActor(admin, userId)
    const requirements: UniversalHit[] = []
    const orders: UniversalHit[] = []
    const invoices: UniversalHit[] = []
    if (actor.msmeId) {
      const { data } = await admin.from('rfqs').select('id, title, status').eq('msme_id', actor.msmeId).is('deleted_at', null).ilike('title', like).order('created_at', { ascending: false }).limit(PER_GROUP)
      for (const r of data ?? []) requirements.push({ id: r.id as string, title: r.title as string, subtitle: null, href: `/app/rfq/${r.id}` })
    }
    const parties: [string, string, string][] = []
    if (actor.msmeId) parties.push(['msme_id', actor.msmeId, '/app/orders'])
    if (actor.providerId) parties.push(['provider_id', actor.providerId, '/partner/orders'])
    for (const [col, id, base] of parties) {
      // Two plain filters (never user text inside an .or() expression).
      const [byTitle, byNumber] = await Promise.all([
        admin.from('orders').select('id, title, order_number').eq(col, id).ilike('title', like).order('created_at', { ascending: false }).limit(PER_GROUP),
        admin.from('orders').select('id, title, order_number').eq(col, id).ilike('order_number', like).limit(PER_GROUP),
      ])
      const seen = new Set(orders.map((o) => o.id))
      for (const o of [...(byNumber.data ?? []), ...(byTitle.data ?? [])]) {
        if (seen.has(o.id as string)) continue
        seen.add(o.id as string)
        orders.push({ id: o.id as string, title: o.title as string, subtitle: (o.order_number as string) ?? null, href: `${base}/${o.id}` })
      }
    }
    if (actor.msmeId) {
      const { data: myOrders } = await admin.from('orders').select('id').eq('msme_id', actor.msmeId).limit(500)
      const ids = (myOrders ?? []).map((o) => o.id as string)
      if (ids.length) {
        const { data } = await admin.from('invoices').select('id, number, order_id').in('order_id', ids).ilike('number', like).limit(PER_GROUP)
        for (const i of data ?? []) invoices.push({ id: i.id as string, title: i.number as string, subtitle: null, href: `/app/invoices` })
      }
    }
    mine = { requirements, orders: orders.slice(0, PER_GROUP), invoices }
  }

  return { q, services, providers, categories, mine }
}
