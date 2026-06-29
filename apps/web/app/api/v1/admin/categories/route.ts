import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { writeAudit } from '@/lib/audit/log'
import { serverError } from '@/lib/api/errors'

const i18n = z.object({ en: z.string().min(1), hi: z.string().min(1) })

const createSchema = z.object({
  slug: z.string().trim().regex(/^[a-z0-9-]+$/, 'kebab-case slug').min(2).max(60),
  nameI18n: i18n,
  descriptionI18n: i18n.partial().optional(),
  icon: z.string().max(40).optional(),
  commissionBps: z.number().int().min(0).max(10000),
  requiredCredentials: z.array(z.string().max(40)).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
})

const patchSchema = z.object({
  id: z.string().uuid(),
  nameI18n: i18n.optional(),
  descriptionI18n: i18n.partial().optional(),
  icon: z.string().max(40).nullable().optional(),
  commissionBps: z.number().int().min(0).max(10000).optional(),
  requiredCredentials: z.array(z.string().max(40)).optional(),
  sortOrder: z.number().int().nullable().optional(),
  isActive: z.boolean().optional(),
})

export async function GET() {
  const gate = await requireAdmin()
  if (gate.error) return gate.error
  const admin = await createAdminClient()
  const { data } = await admin
    .from('categories')
    .select('id, slug, name_i18n, description_i18n, icon, commission_bps, required_credentials, sort_order, is_active')
    .order('sort_order', { ascending: true, nullsFirst: false })
  return NextResponse.json({ categories: data ?? [] })
}

export async function POST(request: NextRequest) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error
  const rl = await enforce(limiters.adminMutation, `admin:${gate.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = createSchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const admin = await createAdminClient()
  const { data: created, error } = await admin
    .from('categories')
    .insert({
      slug: d.slug,
      name_i18n: d.nameI18n,
      description_i18n: d.descriptionI18n ?? null,
      icon: d.icon ?? null,
      commission_bps: d.commissionBps,
      required_credentials: d.requiredCredentials ?? [],
      sort_order: d.sortOrder ?? null,
      is_active: d.isActive ?? true,
    })
    .select('id, slug')
    .single()
  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'A category with this slug already exists' }, { status: 409 })
    return serverError('[admin/categories POST]', error)
  }

  await writeAudit(admin, request, { actorId: gate.userId, action: 'category_create', entity: 'categories', entityId: created.id, after: { slug: created.slug, commission_bps: d.commissionBps } })
  return NextResponse.json({ ok: true, category: created })
}

export async function PATCH(request: NextRequest) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error
  const rl = await enforce(limiters.adminMutation, `admin:${gate.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = patchSchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const { id, ...fields } = parsed.data

  const admin = await createAdminClient()
  const { data: before } = await admin.from('categories').select('commission_bps, is_active, sort_order').eq('id', id).maybeSingle()
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (fields.nameI18n) patch['name_i18n'] = fields.nameI18n
  if (fields.descriptionI18n !== undefined) patch['description_i18n'] = fields.descriptionI18n
  if (fields.icon !== undefined) patch['icon'] = fields.icon
  if (fields.commissionBps !== undefined) patch['commission_bps'] = fields.commissionBps
  if (fields.requiredCredentials !== undefined) patch['required_credentials'] = fields.requiredCredentials
  if (fields.sortOrder !== undefined) patch['sort_order'] = fields.sortOrder
  if (fields.isActive !== undefined) patch['is_active'] = fields.isActive

  const { error } = await admin.from('categories').update(patch).eq('id', id)
  if (error) return serverError('[admin/categories PATCH]', error)

  // NOTE: commission_bps is frozen onto each order at checkout — this change
  // affects ONLY orders placed AFTER it; existing orders keep their rate.
  await writeAudit(admin, request, { actorId: gate.userId, action: 'category_update', entity: 'categories', entityId: id, before, after: patch })
  return NextResponse.json({ ok: true })
}
