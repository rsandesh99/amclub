import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { productInputSchema, aiDecisionSchema, validateProductAttributes } from '@amclub/shared'
import { martApiGate } from '@/lib/mart/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { getSellerCtx } from '@/lib/mart/seller'
import { listSellerProducts } from '@/lib/mart/queries'
import { getMartCategory } from '@/lib/mart/config'
import { listCategoryAttributes } from '@/lib/mart/attributes'
import { addProductEvent, recordAiDecision } from '@/lib/mart/events'
import { publicAssetUrl } from '@/lib/mart/assets'
import { serverError } from '@/lib/api/errors'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

export async function GET() {
  const gate = martApiGate()
  if (gate) return gate
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = await createAdminClient()
  const seller = await getSellerCtx(admin, userId)
  if (!seller) return NextResponse.json({ error: 'No provider profile' }, { status: 404 })
  const products = await listSellerProducts(admin, seller.id)
  return NextResponse.json(
    { products: products.map((p) => ({ ...p, imageUrls: p.images.map(publicAssetUrl) })), sellsGoods: seller.sellsGoods },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}

const createSchema = productInputSchema.extend({
  /** Present when the listing came from the Catalog Agent: proposed fields + refs → ai_decisions. */
  ai: aiDecisionSchema.pick({ input_refs: true, proposed: true }).optional(),
})

/** Create a DRAFT listing (seller confirms every field; nothing is public until approved). */
export async function POST(request: NextRequest) {
  const gate = martApiGate()
  if (gate) return gate
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const rl = await enforce(limiters.authed, `mart-seller:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const admin = await createAdminClient()
  const seller = await getSellerCtx(admin, userId)
  if (!seller) return NextResponse.json({ error: 'No provider profile' }, { status: 404 })
  if (seller.status !== 'active') return NextResponse.json({ error: 'Provider not active' }, { status: 403 })
  const cat = await getMartCategory(admin, d.category_slug)
  if (!cat || !cat.is_active) return NextResponse.json({ error: 'Invalid category' }, { status: 422 })
  if (cat.bis_blocked) return NextResponse.json({ error: 'category_blocked' }, { status: 422 })
  const prefix = `mart/${seller.id}/`
  if (d.images.some((k) => !k.startsWith(prefix))) return NextResponse.json({ error: 'Image not owned by this seller' }, { status: 403 })
  // E16 N40 — typed attributes, validated against the category's definitions.
  const attrs = validateProductAttributes(await listCategoryAttributes(admin, d.category_slug), d.attributes)
  if (!attrs.ok) return NextResponse.json({ error: 'invalid_attributes', problems: attrs.problems }, { status: 422 })

  const { data: product, error } = await admin
    .from('products')
    .insert({
      seller_id: seller.id,
      category_slug: d.category_slug,
      name: d.name,
      description: d.description ?? null,
      hsn_code: d.hsn_code,
      gst_rate_bps: d.gst_rate_bps,
      unit: d.unit,
      images: d.images,
      min_order_qty: d.min_order_qty,
      country_of_origin: d.country_of_origin,
      brand: d.brand ?? null,
      specs: d.specs,
      attributes: attrs.value,
      promises: d.promises,
      sample_price_paise: d.sample_price_paise,
      availability: d.availability,
      lead_time_days: d.availability === 'lead_time' ? (d.lead_time_days ?? null) : null,
      list_price_paise: d.tiers[0]?.unit_price_paise ?? null,
      status: 'draft',
    })
    .select('id')
    .single()
  if (error || !product) return serverError('[mart/seller/products POST]', error)
  const { error: tierErr } = await admin
    .from('price_tiers')
    .insert(d.tiers.map((t) => ({ product_id: product.id, min_qty: t.min_qty, unit_price_paise: t.unit_price_paise })))
  if (tierErr) return serverError('[mart/seller/products POST tiers]', tierErr)

  const { ai, ...rest } = d
  const fields = { ...rest, attributes: attrs.value }
  await addProductEvent(admin, product.id, userId, 'created', { after: fields, from_agent: !!ai })
  if (ai) {
    await recordAiDecision(admin, userId, {
      feature: 'catalog_draft',
      input_refs: { ...ai.input_refs, product_id: product.id },
      proposed: ai.proposed,
      final: { ...fields },
    })
  }
  return NextResponse.json({ id: product.id, status: 'draft' }, { status: 201 })
}
