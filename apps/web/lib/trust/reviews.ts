import 'server-only'
import { createAdminClient } from '@/lib/supabase/server'
import type { ReviewRow } from '@/lib/catalog/types'

export interface ReviewV2 extends ReviewRow {
  /** The buyer has ≥ 2 paid orders with this provider (server-derived; the buyer is never identified). */
  repeatBuyer: boolean
}

export interface ReviewsPage {
  reviews: ReviewV2[]
  /** Counts for 5★ … 1★ (index 0 = 5 stars). */
  histogram: [number, number, number, number, number]
  total: number
  nextCursor: string | null
}

const cursorOf = (r: { created_at: string; id: string }) => Buffer.from(`${r.created_at}|${r.id}`).toString('base64url')
function parseCursor(c: string | null | undefined): { at: string; id: string } | null {
  if (!c) return null
  try {
    const [at, id] = Buffer.from(c, 'base64url').toString('utf8').split('|')
    // Strict shapes only — these values go into a PostgREST filter.
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/
    return at && id && /^[0-9a-f-]{36}$/i.test(id) && iso.test(at) ? { at, id } : null
  } catch { return null }
}

/**
 * N13 — published reviews for one provider, newest first, keyset-paginated,
 * with the rating histogram and the "repeat buyer" marker. Service role with
 * explicit safe columns: msme_id is read only to derive the marker and is
 * never returned.
 */
export async function reviewsV2(providerId: string, opts: { cursor?: string | null; limit?: number } = {}): Promise<ReviewsPage> {
  const admin = await createAdminClient()
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50)
  const cur = parseCursor(opts.cursor)
  let q = admin
    .from('reviews')
    .select('id, rating, text, provider_reply, created_at, msme_id')
    .eq('provider_id', providerId)
    .eq('status', 'published')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1)
  if (cur) q = q.or(`created_at.lt.${cur.at},and(created_at.eq.${cur.at},id.lt.${cur.id})`)
  const [{ data: rows }, { data: all }] = await Promise.all([
    q,
    admin.from('reviews').select('rating').eq('provider_id', providerId).eq('status', 'published'),
  ])
  const page = (rows ?? []).slice(0, limit)
  const msmes = [...new Set(page.map((r) => r.msme_id as string))]
  const perBuyer = new Map<string, number>()
  if (msmes.length) {
    const { data: orders } = await admin.from('orders').select('msme_id').eq('provider_id', providerId).in('msme_id', msmes)
    for (const o of orders ?? []) perBuyer.set(o.msme_id as string, (perBuyer.get(o.msme_id as string) ?? 0) + 1)
  }
  const histogram: [number, number, number, number, number] = [0, 0, 0, 0, 0]
  for (const r of all ?? []) {
    const n = Math.round(Number(r.rating))
    if (n >= 1 && n <= 5) histogram[5 - n] = (histogram[5 - n] ?? 0) + 1
  }
  return {
    reviews: page.map((r) => ({
      id: r.id as string,
      rating: Number(r.rating),
      body: (r.text as string | null) ?? null,
      authorName: null,
      providerReply: (r.provider_reply as string | null) ?? null,
      createdAt: r.created_at as string,
      repeatBuyer: (perBuyer.get(r.msme_id as string) ?? 0) >= 2,
    })),
    histogram,
    total: (all ?? []).length,
    nextCursor: (rows ?? []).length > limit ? cursorOf(page[page.length - 1] as { created_at: string; id: string }) : null,
  }
}

/** Histogram + repeat markers for a page of reviews the caller already loaded (offset pages). */
export async function reviewExtras(providerId: string, reviewIds: string[]): Promise<{ histogram: ReviewsPage['histogram']; repeat: Set<string> }> {
  const admin = await createAdminClient()
  const [{ data: all }, { data: mine }] = await Promise.all([
    admin.from('reviews').select('rating').eq('provider_id', providerId).eq('status', 'published'),
    reviewIds.length ? admin.from('reviews').select('id, msme_id').in('id', reviewIds) : Promise.resolve({ data: [] as { id: string; msme_id: string }[] }),
  ])
  const histogram: ReviewsPage['histogram'] = [0, 0, 0, 0, 0]
  for (const r of all ?? []) {
    const n = Math.round(Number(r.rating))
    if (n >= 1 && n <= 5) histogram[5 - n] = (histogram[5 - n] ?? 0) + 1
  }
  const msmes = [...new Set((mine ?? []).map((r) => r.msme_id as string))]
  const perBuyer = new Map<string, number>()
  if (msmes.length) {
    const { data: orders } = await admin.from('orders').select('msme_id').eq('provider_id', providerId).in('msme_id', msmes)
    for (const o of orders ?? []) perBuyer.set(o.msme_id as string, (perBuyer.get(o.msme_id as string) ?? 0) + 1)
  }
  const repeat = new Set((mine ?? []).filter((r) => (perBuyer.get(r.msme_id as string) ?? 0) >= 2).map((r) => r.id as string))
  return { histogram, repeat }
}
