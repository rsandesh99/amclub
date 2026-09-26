import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { martApiGate } from '@/lib/mart/gate'
import { requireNotDelegated } from '@/lib/agent/scope'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { getSellerCtx } from '@/lib/mart/seller'
import { listMartCategories } from '@/lib/mart/config'
import { draftListing } from '@/lib/mart/catalog-agent'
import { publicAssetUrl } from '@/lib/mart/assets'
import { BudgetExceededError } from '@/lib/agent/bounded'
import { classifyVendorFailure } from '@/lib/voice/types'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

const bodySchema = z.object({
  description: z.string().trim().max(2000).default(''),
  /** Keys returned by /seller/images (must sit under this seller's prefix). */
  imageKeys: z.array(z.string().max(300)).max(6).default([]),
})

/**
 * Catalog Agent v1 — returns a DRAFT the seller confirms field by field. Paid
 * model call → voice-parse rate limits, a verified goods seller only, and the
 * AI budget (the bounded helper, audit M24); every call logged to ai_invocations.
 */
export async function POST(request: NextRequest) {
  const gate = martApiGate()
  if (gate) return gate
  // Audit wave 3: no agent tool wraps this route, so a delegated agent token is refused.
  const delegated = await requireNotDelegated('POST /mart/seller/products/draft')
  if (delegated) return delegated
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const [burst, hourly] = await Promise.all([
    enforce(limiters.voiceParse, `catalog-draft:${userId}`),
    enforce(limiters.voiceParseHourly, `catalog-draft-h:${userId}`),
  ])
  if (!burst.ok) return tooManyRequests(burst.retryAfter)
  if (!hourly.ok) return tooManyRequests(hourly.retryAfter)

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  if (!parsed.data.description && parsed.data.imageKeys.length === 0) {
    return NextResponse.json({ error: 'Add a photo or a description' }, { status: 422 })
  }
  const admin = await createAdminClient()
  const seller = await getSellerCtx(admin, userId)
  if (!seller) return NextResponse.json({ error: 'No provider profile' }, { status: 404 })
  // Audit M24: a paid model call only for a verified goods seller (active provider, sells_goods — which itself needs a
  // verified GSTIN), so any signed-in account can no longer spend the AI budget here.
  if (seller.status !== 'active' || !seller.sellsGoods) return NextResponse.json({ error: 'not_a_seller' }, { status: 403 })
  const prefix = `mart/${seller.id}/`
  if (parsed.data.imageKeys.some((k) => !k.startsWith(prefix))) {
    return NextResponse.json({ error: 'Image not owned by this seller' }, { status: 403 })
  }

  const categories = await listMartCategories()
  try {
    // The bounded helper checks the budget first and writes the ONE ai_invocations row (feature catalog_draft).
    const r = await draftListing(admin, userId, { description: parsed.data.description, imageUrls: parsed.data.imageKeys.map(publicAssetUrl), categories })
    return NextResponse.json({ draft: r.draft, stub: r.stub, vendor: r.vendor, inputRefs: { image_keys: parsed.data.imageKeys, description_chars: parsed.data.description.length } })
  } catch (e) {
    const cause = e instanceof BudgetExceededError ? 'quota' : classifyVendorFailure(e)
    return NextResponse.json({ error: 'draft_failed', cause }, { status: cause === 'quota' ? 402 : 503 })
  }
}
