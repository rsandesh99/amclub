import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import {
  productInputSchema,
  productStatusActionSchema,
  isValidProductTransition,
  validateProductAttributes,
  productEditReview,
  PRODUCT_MATERIAL_FIELDS,
  POOL_LIVE_STATUSES,
  type ProductStatus,
} from '@amclub/shared'
import { martApiGate } from '@/lib/mart/gate'
import { requireNotDelegated } from '@/lib/agent/scope'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { getSellerCtx } from '@/lib/mart/seller'
import { getSellerProduct } from '@/lib/mart/queries'
import { getMartCategory, getAutoApproveAfterListings } from '@/lib/mart/config'
import { listCategoryAttributes } from '@/lib/mart/attributes'
import { addProductEvent } from '@/lib/mart/events'
import { publicAssetUrl } from '@/lib/mart/assets'
import { serverError } from '@/lib/api/errors'
import { revalidateMart } from '@/lib/mart/revalidate'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

type Ctx = { params: Promise<{ id: string }> }

async function ctx(id: string) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = await createAdminClient()
  const seller = await getSellerCtx(admin, userId)
  if (!seller) return { error: NextResponse.json({ error: 'No provider profile' }, { status: 404 }) }
  const product = await getSellerProduct(admin, seller.id, id)
  if (!product) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  return { userId, admin, seller, product }
}

export async function GET(_request: NextRequest, { params }: Ctx) {
  const gate = martApiGate()
  if (gate) return gate
  const { id } = await params
  const c = await ctx(id)
  if (c.error) return c.error
  const { data: events } = await c.admin
    .from('product_events')
    .select('id, event_type, payload, created_at')
    .eq('product_id', id)
    .order('created_at', { ascending: false })
    .limit(50)
  return NextResponse.json(
    { product: { ...c.product, imageUrls: c.product.images.map(publicAssetUrl) }, events: events ?? [] },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}

/**
 * Full edit (fields + tiers). Emits 'edited' with a before/after diff and 'price_changed' when tiers move.
 * Audit M16: a material field (shared PRODUCT_MATERIAL_FIELDS) on an approved listing sends it back to
 * review (shared productEditReview); refused (409 pool_live) while a pool on the listing is live.
 */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const gate = martApiGate()
  if (gate) return gate
  // Audit wave 3: no agent tool wraps this route, so a delegated agent token is refused.
  const delegated = await requireNotDelegated('PATCH /mart/seller/products/[id]')
  if (delegated) return delegated
  const { id } = await params
  const c = await ctx(id)
  if (c.error) return c.error
  const rl = await enforce(limiters.authed, `mart-seller:${c.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const parsed = productInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data
  const cat = await getMartCategory(c.admin, d.category_slug)
  if (!cat || !cat.is_active || cat.bis_blocked) return NextResponse.json({ error: 'Invalid category' }, { status: 422 })
  if (d.images.some((k) => !k.startsWith(`mart/${c.seller.id}/`))) return NextResponse.json({ error: 'Image not owned by this seller' }, { status: 403 })
  // E16 N40 — typed attributes, validated against the (possibly new) category's definitions.
  const attrs = validateProductAttributes(await listCategoryAttributes(c.admin, d.category_slug), d.attributes)
  if (!attrs.ok) return NextResponse.json({ error: 'invalid_attributes', problems: attrs.problems }, { status: 422 })

  const before = {
    category_slug: c.product.categorySlug, name: c.product.name, description: c.product.description, hsn_code: c.product.hsnCode,
    gst_rate_bps: c.product.gstRateBps, unit: c.product.unit, images: c.product.images, min_order_qty: c.product.minOrderQty,
    country_of_origin: c.product.countryOfOrigin, brand: c.product.brand, specs: c.product.specs, availability: c.product.availability,
    lead_time_days: c.product.leadTimeDays, attributes: c.product.attributes, promises: c.product.promises,
    sample_price_paise: c.product.samplePricePaise,
  }
  const after = {
    category_slug: d.category_slug, name: d.name, description: d.description ?? null, hsn_code: d.hsn_code, gst_rate_bps: d.gst_rate_bps,
    unit: d.unit, images: d.images, min_order_qty: d.min_order_qty, country_of_origin: d.country_of_origin, brand: d.brand ?? null,
    specs: d.specs, availability: d.availability, lead_time_days: d.availability === 'lead_time' ? (d.lead_time_days ?? null) : null,
    attributes: attrs.value,
    promises: d.promises,
    sample_price_paise: d.sample_price_paise,
  }
  const changed = Object.keys(after).filter((k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k]))
  const material = changed.filter((k) => (PRODUCT_MATERIAL_FIELDS as readonly string[]).includes(k))
  const from = c.product.status as ProductStatus

  // Audit M16 — a live pool froze this listing's terms for its members (the pool's tax
  // snapshot, and a listing that must stay active for them to pay): no material edit
  // until it settles.
  if (material.length > 0) {
    const { count: livePools, error: poolErr } = await c.admin
      .from('pools')
      .select('id', { count: 'exact', head: true })
      .eq('product_id', id)
      .in('status', POOL_LIVE_STATUSES as string[])
      .is('deleted_at', null)
    if (poolErr) return serverError('[mart/seller/products PATCH pools]', poolErr)
    if ((livePools ?? 0) > 0) return NextResponse.json({ error: 'pool_live', fields: material }, { status: 409 })
  }

  // Audit M16 — what the admin approved is what stays live: a material edit of an
  // approved listing goes back to review (always for a category change; a seller
  // past the auto-approve threshold keeps other material edits live, as on submit).
  let review: 'none' | 'auto' | 'required' = 'none'
  if (material.length > 0 && (from === 'active' || from === 'suspended')) {
    const n = await getAutoApproveAfterListings(c.admin)
    const { count: approvedOthers } = await c.admin
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('seller_id', c.seller.id)
      .neq('id', id)
      .not('approved_at', 'is', null)
    review = productEditReview(changed, (approvedOthers ?? 0) >= n)
  }
  const reReview = review === 'required'
  // An active listing leaves the catalogue now; a suspended one keeps its status but loses
  // its approval, so a later seller reactivation goes to review (POST reactivate below).
  const to: ProductStatus = reReview && from === 'active' ? 'pending_approval' : from
  if (to !== from && !isValidProductTransition(from, to)) return NextResponse.json({ error: `Illegal transition ${from} → ${to}` }, { status: 409 })

  // Compare-and-set on the status read above: an admin decision that landed meanwhile wins.
  const { data: moved, error } = await c.admin
    .from('products')
    .update({
      ...after,
      list_price_paise: d.tiers[0]?.unit_price_paise ?? null,
      updated_at: new Date().toISOString(),
      ...(reReview ? { status: to, approved_at: null, approved_by: null } : {}),
    })
    .eq('id', id)
    .eq('status', from)
    .select('id')
  if (error) return serverError('[mart/seller/products PATCH]', error)
  if (!moved?.length) return NextResponse.json({ error: 'product_changed' }, { status: 409 })

  const oldTiers = c.product.tiers.map((t) => ({ min_qty: t.min_qty, unit_price_paise: t.unit_price_paise }))
  const newTiers = d.tiers.map((t) => ({ min_qty: t.min_qty, unit_price_paise: t.unit_price_paise }))
  const tiersChanged = JSON.stringify(oldTiers) !== JSON.stringify(newTiers)
  if (tiersChanged) {
    await c.admin.from('price_tiers').delete().eq('product_id', id)
    const { error: tErr } = await c.admin.from('price_tiers').insert(newTiers.map((t) => ({ product_id: id, ...t })))
    if (tErr) return serverError('[mart/seller/products PATCH tiers]', tErr)
  }
  if (changed.length > 0) {
    await addProductEvent(c.admin, id, c.userId, 'edited', {
      before: Object.fromEntries(changed.map((k) => [k, (before as Record<string, unknown>)[k]])),
      after: Object.fromEntries(changed.map((k) => [k, (after as Record<string, unknown>)[k]])),
      ...(review !== 'none' ? { review, material } : {}),
    })
  }
  if (reReview && to === 'pending_approval') await addProductEvent(c.admin, id, c.userId, 'submitted', { rereview: true, from, fields: material })
  if (tiersChanged) await addProductEvent(c.admin, id, c.userId, 'price_changed', { before: oldTiers, after: newTiers })
  if (from === 'active') {
    revalidateMart({ productId: id, categorySlug: d.category_slug, providerSlug: c.product.seller.slug })
    if (d.category_slug !== c.product.categorySlug) revalidateMart({ productId: id, categorySlug: c.product.categorySlug, providerSlug: c.product.seller.slug })
  }
  return NextResponse.json({ id, status: to, ...(review !== 'none' ? { review } : {}) })
}

/**
 * Seller status actions: submit (draft only → pending_approval, or straight to
 * active once the seller has N admin-approved listings — config), suspend
 * (active → suspended), reactivate (suspended → active; only if the seller
 * suspended it themselves and it was approved before; a listing whose current version
 * lost its approval to a material edit goes to pending_approval instead — audit M16).
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const gate = martApiGate()
  if (gate) return gate
  // Audit wave 3: no agent tool wraps this route, so a delegated agent token is refused.
  const delegated = await requireNotDelegated('POST /mart/seller/products/[id]')
  if (delegated) return delegated
  const { id } = await params
  const c = await ctx(id)
  if (c.error) return c.error
  const parsed = productStatusActionSchema.safeParse((await request.json().catch(() => null))?.action)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid action' }, { status: 422 })
  const action = parsed.data
  const from = c.product.status as ProductStatus
  const now = new Date().toISOString()

  if (action === 'submit') {
    if (!c.seller.sellsGoods) return NextResponse.json({ error: 'activation_required' }, { status: 409 })
    // Submit is draft-only. The M16 edges active / suspended → pending_approval are
    // reached only through a material edit or a reactivate: a "submit" of a live or
    // suspended listing would auto-activate an admin-suspended one for a trusted
    // seller, or pull a pooled listing off the catalogue past the pool_live guard.
    if (from !== 'draft' || !isValidProductTransition(from, 'pending_approval')) return NextResponse.json({ error: `Cannot submit from ${from}` }, { status: 409 })
    const n = await getAutoApproveAfterListings(c.admin)
    const { count } = await c.admin.from('products').select('id', { count: 'exact', head: true }).eq('seller_id', c.seller.id).not('approved_at', 'is', null)
    const autoApprove = (count ?? 0) >= n
    const to: ProductStatus = autoApprove ? 'active' : 'pending_approval'
    const { data: moved, error } = await c.admin
      .from('products')
      .update({ status: to, updated_at: now, ...(autoApprove ? { approved_at: now, approved_by: null } : {}) })
      .eq('id', id)
      .eq('status', from)
      .select('id')
    if (error) return serverError('[mart/seller/products submit]', error)
    if (!moved?.length) return NextResponse.json({ error: 'product_changed' }, { status: 409 })
    await addProductEvent(c.admin, id, c.userId, 'submitted', null)
    if (autoApprove) {
      await addProductEvent(c.admin, id, c.userId, 'activated', { auto: true, approved_listings: count })
      revalidateMart({ productId: id, categorySlug: c.product.categorySlug, providerSlug: c.product.seller.slug })
    }
    return NextResponse.json({ id, status: to })
  }
  if (action === 'suspend') {
    if (!isValidProductTransition(from, 'suspended')) return NextResponse.json({ error: `Cannot suspend from ${from}` }, { status: 409 })
    const { error } = await c.admin.from('products').update({ status: 'suspended', updated_at: now }).eq('id', id).eq('status', from)
    if (error) return serverError('[mart/seller/products suspend]', error)
    await addProductEvent(c.admin, id, c.userId, 'suspended', { by: 'seller' })
    revalidateMart({ productId: id, categorySlug: c.product.categorySlug, providerSlug: c.product.seller.slug })
    return NextResponse.json({ id, status: 'suspended' })
  }
  // reactivate
  if (!isValidProductTransition(from, 'active')) return NextResponse.json({ error: `Cannot reactivate from ${from}` }, { status: 409 })
  const { data: lastSuspend } = await c.admin
    .from('product_events').select('payload').eq('product_id', id).eq('event_type', 'suspended').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if ((lastSuspend?.payload as { by?: string } | null)?.by === 'admin') return NextResponse.json({ error: 'suspended_by_admin' }, { status: 403 })
  if (!c.seller.sellsGoods) return NextResponse.json({ error: 'activation_required' }, { status: 409 })
  // Audit M16 — a material edit while suspended removed the approval: the listing comes back through review.
  const { data: appr } = await c.admin.from('products').select('approved_at').eq('id', id).maybeSingle()
  if (!appr?.approved_at) {
    if (!isValidProductTransition(from, 'pending_approval')) return NextResponse.json({ error: `Cannot reactivate from ${from}` }, { status: 409 })
    const { data: moved, error } = await c.admin.from('products').update({ status: 'pending_approval', updated_at: now }).eq('id', id).eq('status', 'suspended').select('id')
    if (error) return serverError('[mart/seller/products reactivate → review]', error)
    if (!moved?.length) return NextResponse.json({ error: 'product_changed' }, { status: 409 })
    await addProductEvent(c.admin, id, c.userId, 'submitted', { by: 'seller', rereview: true, from: 'suspended' })
    return NextResponse.json({ id, status: 'pending_approval', review: 'required' })
  }
  const { data: moved, error } = await c.admin.from('products').update({ status: 'active', updated_at: now }).eq('id', id).eq('status', 'suspended').select('id')
  if (error) return serverError('[mart/seller/products reactivate]', error)
  if (!moved?.length) return NextResponse.json({ error: 'product_changed' }, { status: 409 })
  await addProductEvent(c.admin, id, c.userId, 'activated', { by: 'seller', reactivated: true })
  revalidateMart({ productId: id, categorySlug: c.product.categorySlug, providerSlug: c.product.seller.slug })
  return NextResponse.json({ id, status: 'active' })
}
