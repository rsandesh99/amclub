import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { CATEGORY_LIST } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated, requireToolScope } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { captureServerEvent } from '@/lib/analytics/server'

/**
 * S2.2 — the provider's price book (spine, no flag).
 *  GET  — the provider's own rows (accepted first, then newest; ≤ 50 per
 *         category). Bearer OK; a delegated token needs the `read_price_book`
 *         scope (Munshi's only basis for a draft price).
 *  POST — a MANUAL row (source 'manual'): how a provider with no quote history
 *         seeds Munshi. Session only (never a delegated token).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const PER_CATEGORY = 50

const manualRowSchema = z
  .object({
    category_slug: z.string().min(1).max(80),
    specialization: z.string().min(1).max(80).nullable().optional(),
    unit: z.string().min(1).max(40).default('job'),
    price_paise: z.number().int().positive().max(100_000_000_00),
    delivery_days: z.number().int().min(1).max(365).nullable().optional(),
    gst_included: z.boolean().nullable().optional(),
    transport_included: z.boolean().nullable().optional(),
  })
  .strict()

export interface PriceBookRowView {
  id: string
  kind: string
  category_slug: string
  specialization: string | null
  unit: string
  price_paise: number
  delivery_days: number | null
  gst_included: boolean | null
  transport_included: boolean | null
  source: 'quote' | 'manual'
  source_quote_id: string | null
  confirmed_at: string
  accepted_at: string | null
}

const COLS = 'id, kind, category_slug, specialization, unit, price_paise, delivery_days, gst_included, transport_included, source, source_quote_id, confirmed_at, accepted_at'

export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const scope = await requireToolScope('read_price_book')
  if (scope) return scope
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return NextResponse.json({ error: 'Not a provider' }, { status: 403 })
  const { data, error } = await admin
    .from('provider_price_book')
    .select(COLS)
    .eq('provider_id', actor.providerId)
    .is('deleted_at', null)
    .order('accepted_at', { ascending: false, nullsFirst: false })
    .order('confirmed_at', { ascending: false })
    .limit(500)
  if (error) return NextResponse.json({ error: 'price_book_unavailable' }, { status: 503 })
  const perCategory = new Map<string, number>()
  const rows = ((data as PriceBookRowView[] | null) ?? []).filter((r) => {
    const n = (perCategory.get(r.category_slug) ?? 0) + 1
    perCategory.set(r.category_slug, n)
    return n <= PER_CATEGORY
  })
  return NextResponse.json({ rows }, { headers: NO_STORE })
}

export async function POST(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('POST /partner/price-book')
  if (delegated) return delegated
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return NextResponse.json({ error: 'Not a provider' }, { status: 403 })
  const rl = await enforce(limiters.authed, `price-book:${actor.providerId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const parsed = manualRowSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data
  if (!CATEGORY_LIST.some((c) => c.slug === d.category_slug)) return NextResponse.json({ error: 'unknown_category' }, { status: 422 })
  const now = new Date().toISOString()
  const { data, error } = await admin
    .from('provider_price_book')
    .insert({
      provider_id: actor.providerId,
      kind: 'services',
      category_slug: d.category_slug,
      specialization: d.specialization ?? null,
      unit: d.unit,
      price_paise: d.price_paise,
      delivery_days: d.delivery_days ?? null,
      gst_included: d.gst_included ?? null,
      transport_included: d.transport_included ?? null,
      source: 'manual',
      source_quote_id: null,
      confirmed_at: now,
    })
    .select(COLS)
    .single()
  if (error) return NextResponse.json({ error: 'price_book_unavailable' }, { status: 503 })
  captureServerEvent(userId, 'munshi_price_book_row_added', { category_slug: d.category_slug })
  return NextResponse.json({ row: data as PriceBookRowView }, { status: 201, headers: NO_STORE })
}
