import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { productReviewSchema, isValidProductTransition, type ProductStatus } from '@amclub/shared'
import { martApiGate } from '@/lib/mart/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { addProductEvent } from '@/lib/mart/events'
import { writeAudit } from '@/lib/audit/log'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'
import { revalidateMart } from '@/lib/mart/revalidate'

/** Admin listing review: approve (→ active), reject (→ draft, reason), suspend (→ suspended, reason). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = martApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const rl = await enforce(limiters.adminMutation, `admin:${auth.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const { id } = await params
  const parsed = productReviewSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const admin = await createAdminClient()
  const { data: product } = await admin
    .from('products')
    .select('id, status, seller_id, category_slug, seller:provider_profiles!inner(slug)')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (!product) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const from = product.status as ProductStatus
  const to: ProductStatus = d.action === 'approve' ? 'active' : d.action === 'reject' ? 'draft' : 'suspended'
  if (!isValidProductTransition(from, to)) return NextResponse.json({ error: `Illegal transition ${from} → ${to}` }, { status: 409 })

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { status: to, updated_at: now }
  if (d.action === 'approve') Object.assign(patch, { approved_by: auth.userId, approved_at: now })
  // Compare-and-set on the status; an approval is also pinned to the version the admin
  // reviewed (audit M16) — an edit that landed since → 409 listing_changed, nothing moves.
  let q = admin.from('products').update(patch).eq('id', id).eq('status', from)
  if (d.action === 'approve') q = d.reviewed_updated_at === null ? q.is('updated_at', null) : q.eq('updated_at', d.reviewed_updated_at)
  const { data: moved, error } = await q.select('id')
  if (error) return serverError('[mart/admin/products review]', error)
  if (!moved?.length) return NextResponse.json({ error: d.action === 'approve' ? 'listing_changed' : 'product_changed' }, { status: 409 })

  const reason = d.action === 'approve' ? undefined : d.reason
  await addProductEvent(admin, id, auth.userId, d.action === 'approve' ? 'activated' : d.action === 'reject' ? 'rejected' : 'suspended', {
    by: 'admin',
    ...(reason ? { reason } : {}),
  })
  await writeAudit(admin, request, {
    actorId: auth.userId,
    action: `mart_product_${d.action}`,
    entity: 'products',
    entityId: id,
    before: { status: from, ...(d.action === 'approve' ? { reviewed_updated_at: d.reviewed_updated_at } : {}) },
    after: { status: to, ...(reason ? { reason } : {}) },
  })
  // Edge cache purge so an approval is live in seconds (Phase 3 "<5s" criterion).
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sellerRel = (product as any).seller
  const providerSlug: string | undefined = (Array.isArray(sellerRel) ? sellerRel[0] : sellerRel)?.slug
  /* eslint-enable @typescript-eslint/no-explicit-any */
  revalidateMart({ productId: id, categorySlug: product.category_slug as string, ...(providerSlug ? { providerSlug } : {}) })
  return NextResponse.json({ id, status: to })
}
