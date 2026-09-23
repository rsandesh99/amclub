import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createPublicClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { isOnFor } from '@/lib/experiments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const KEEP = 20
const bodySchema = z.object({ kind: z.enum(['provider', 'package']), refId: z.string().uuid() }).strict()

/**
 * Experience v3 E2b FR-2.8 (N8) — the signed-in buyer's recently viewed
 * providers and packages. The caller's own session client (owner-only RLS):
 * POST upserts one view and keeps the newest 20; GET resolves them to public
 * titles + links (a package or provider that is no longer live drops out).
 */
export async function POST(request: NextRequest) {
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  if (!isOnFor('search', userId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const rl = await enforce(limiters.authed, `recent-views:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const { error } = await supabase
    .from('recent_views')
    .upsert({ user_id: userId, kind: parsed.data.kind, ref_id: parsed.data.refId, viewed_at: new Date().toISOString() }, { onConflict: 'user_id,kind,ref_id' })
  if (error) return NextResponse.json({ error: 'recent_views_unavailable' }, { status: 503 })
  const { data: stale } = await supabase
    .from('recent_views')
    .select('id')
    .eq('user_id', userId)
    .order('viewed_at', { ascending: false })
    .range(KEEP, KEEP + 50)
  if (stale && stale.length > 0) await supabase.from('recent_views').delete().in('id', stale.map((r) => r.id as string))
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}

export async function GET() {
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  if (!isOnFor('search', userId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { data, error } = await supabase
    .from('recent_views')
    .select('kind, ref_id, viewed_at')
    .eq('user_id', userId)
    .order('viewed_at', { ascending: false })
    .limit(KEEP)
  if (error) return NextResponse.json({ error: 'recent_views_unavailable' }, { status: 503 })
  const rows = (data ?? []) as { kind: 'provider' | 'package'; ref_id: string; viewed_at: string }[]
  const pub = createPublicClient()
  const provIds = rows.filter((r) => r.kind === 'provider').map((r) => r.ref_id)
  const pkgIds = rows.filter((r) => r.kind === 'package').map((r) => r.ref_id)
  const [{ data: provs }, { data: pkgs }] = await Promise.all([
    provIds.length ? pub.from('provider_profiles').select('id, slug, display_name').in('id', provIds).eq('status', 'active').is('deleted_at', null) : Promise.resolve({ data: [] }),
    pkgIds.length
      ? pub.from('packages').select('id, slug, title_i18n, provider:provider_profiles!inner(slug, status)').in('id', pkgIds).eq('status', 'active').is('deleted_at', null)
      : Promise.resolve({ data: [] }),
  ])
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prov = new Map(((provs ?? []) as any[]).map((p) => [p.id, { title: { en: p.display_name as string }, href: `/p/${p.slug}` }]))
  const pack = new Map(((pkgs ?? []) as any[]).filter((p) => p.provider?.status === 'active').map((p) => [p.id, { title: p.title_i18n as { en: string; hi?: string }, href: `/p/${p.provider.slug}/${p.slug}` }]))
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const items = rows
    .map((r) => {
      const hit = r.kind === 'provider' ? prov.get(r.ref_id) : pack.get(r.ref_id)
      return hit ? { kind: r.kind, id: r.ref_id, title: hit.title, href: hit.href, viewedAt: r.viewed_at } : null
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  return NextResponse.json({ items }, { headers: NO_STORE })
}
