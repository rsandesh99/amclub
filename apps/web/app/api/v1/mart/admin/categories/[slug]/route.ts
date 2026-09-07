import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { martCategoryPatchSchema } from '@amclub/shared'
import { martApiGate } from '@/lib/mart/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { getMartCategory } from '@/lib/mart/config'
import { writeAudit, stableEntityId } from '@/lib/audit/log'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'
import { revalidateMart } from '@/lib/mart/revalidate'

/**
 * Launch Gate — §9.2 (return window, return freight) and §9.3 (commission) per
 * category, edited here and never in code. Commission applies to NEW orders
 * only (sessions freeze commission_bps at checkout); the return window applies
 * to orders delivered after the change (release gate reads the category).
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const gate = martApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const rl = await enforce(limiters.adminMutation, `admin:${auth.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const { slug } = await params
  const parsed = martCategoryPatchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const before = await getMartCategory(admin, slug)
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const patch = { ...parsed.data, updated_at: new Date().toISOString() }
  const { error } = await admin.from('mart_categories').update(patch).eq('slug', slug)
  if (error) return serverError('[mart/admin/categories PATCH]', error)
  const after = await getMartCategory(admin, slug)
  await writeAudit(admin, request, {
    actorId: auth.userId,
    action: 'mart_category_update',
    entity: 'mart_categories',
    entityId: stableEntityId('mart_categories', slug),
    before: { slug, ...pick(before as unknown as Record<string, unknown>, parsed.data) },
    after: { slug, ...pick(after as unknown as Record<string, unknown> | null, parsed.data) },
  })
  // Category name / return-window note is rendered on ISR product + category pages.
  revalidateMart({ categorySlug: slug })
  return NextResponse.json({ category: after }, { headers: { 'Cache-Control': 'private, no-store' } })
}

function pick(row: Record<string, unknown> | null, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(patch)) out[k] = row ? row[k] : null
  return out
}
