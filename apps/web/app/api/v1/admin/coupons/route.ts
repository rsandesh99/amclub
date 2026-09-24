import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { adminCouponCreateSchema } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { requireNotDelegated } from '@/lib/agent/scope'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { writeAudit } from '@/lib/audit/log'
import { serverError } from '@/lib/api/errors'
import { COUPONS_ENABLED } from '@/lib/flags'

/**
 * Admin coupon management (A6 / §5.5). `value` is human units: for percent it's
 * a percentage (10 → 1000 bps); for fixed it's rupees (500 → 50000 paise). All
 * money is normalised to integer paise/bps before storage (§2.5 rule 6). The
 * schema is shared `adminCouponCreateSchema` (audit M10 adds `perBuyerLimit`).
 */
const createSchema = adminCouponCreateSchema

export async function GET() {
  if (!COUPONS_ENABLED) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const gate = await requireAdmin()
  if (gate.error) return gate.error
  const admin = await createAdminClient()
  const { data } = await admin
    .from('coupons')
    .select('id, code, kind, value_bps, max_discount_paise, category_id, valid_from, valid_to, usage_limit, per_buyer_limit, used_count, is_active, created_at, category:categories(slug, name_i18n)')
    .order('created_at', { ascending: false })
    .limit(200)
  return NextResponse.json({ coupons: data ?? [] })
}

export async function POST(request: NextRequest) {
  if (!COUPONS_ENABLED) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const gate = await requireAdmin()
  if (gate.error) return gate.error
  // Audit M11 — a coupon moves money: never an agent tool, rate-limited, audit-logged.
  const delegated = await requireNotDelegated('POST /admin/coupons')
  if (delegated) return delegated
  const rl = await enforce(limiters.adminMutation, `admin:${gate.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = createSchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  if (new Date(d.validTo) <= new Date(d.validFrom)) {
    return NextResponse.json({ error: { formErrors: ['validTo must be after validFrom'], fieldErrors: {} } }, { status: 422 })
  }

  const admin = await createAdminClient()

  let categoryId: string | null = null
  if (d.categorySlug) {
    const { data: cat } = await admin.from('categories').select('id').eq('slug', d.categorySlug).maybeSingle()
    if (!cat) return NextResponse.json({ error: 'Unknown category' }, { status: 422 })
    categoryId = cat.id
  }

  const valueBps = d.kind === 'percent' ? Math.round(d.value * 100) : Math.round(d.value * 100) // %→bps, ₹→paise
  const maxDiscountPaise = d.maxDiscountRupees != null ? Math.round(d.maxDiscountRupees * 100) : null

  const row = {
    code: d.code,
    kind: d.kind,
    value_bps: valueBps,
    max_discount_paise: maxDiscountPaise,
    category_id: categoryId,
    valid_from: d.validFrom,
    valid_to: d.validTo,
    usage_limit: d.usageLimit ?? null,
    // Audit M10 (0081) — uses per buyer business; absent = unlimited (the column's NULL).
    ...(d.perBuyerLimit != null ? { per_buyer_limit: d.perBuyerLimit } : {}),
    is_active: true,
  }
  const { data: created, error } = await admin.from('coupons').insert(row).select('id, code').single()

  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'A coupon with this code already exists' }, { status: 409 })
    return serverError('[admin/coupons POST]', error)
  }
  // §7 — every admin mutation is audit-logged (the whole created row).
  await writeAudit(admin, request, { actorId: gate.userId, action: 'coupon_create', entity: 'coupons', entityId: created.id, before: null, after: row })
  return NextResponse.json({ ok: true, coupon: created })
}
