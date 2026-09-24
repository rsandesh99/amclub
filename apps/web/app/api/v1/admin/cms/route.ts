import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { SUPPORTED_LOCALES } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { requireNotDelegated } from '@/lib/agent/scope'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { writeAudit } from '@/lib/audit/log'
import { getMaxDiscountPct } from '@/lib/cms/queries'
import { serverError } from '@/lib/api/errors'

const i18nText = z.object({ en: z.string().trim().min(1).max(200), hi: z.string().trim().max(200).optional() })

// F4 (SECURITY_AUDIT): banner links render as raw hrefs on public pages, so a
// javascript:/data: scheme here — z.string().url() accepts them — would be
// persistent XSS on every visitor if an admin account is ever phished.
// Allowlist: https:// absolute, or a same-site relative path ('/x', not '//x').
const safeHref = z
  .string()
  .trim()
  .max(300)
  .refine((v) => /^https:\/\/[^\s]+$/i.test(v) || (v.startsWith('/') && !v.startsWith('//')), {
    message: 'must be an https:// URL or a site-relative path',
  })
const safeImageUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https:\/\/[^\s]+$/i.test(v), { message: 'must be an https:// URL' })

const createSchema = z
  .object({
    slot: z.string().trim().min(1).max(40),
    variant: z.enum(['image', 'hero']).default('image'),
    imageUrl: safeImageUrl.optional(),
    link: safeHref.optional(),
    headline: i18nText.optional(),
    subline: i18nText.optional(),
    ctaLabel: i18nText.optional(),
    ctaHref: safeHref.optional(),
    discountPct: z.number().int().min(0).max(100).optional(),
    locale: z.enum(SUPPORTED_LOCALES).nullable().optional(),
    startsAt: z.string().datetime().nullable().optional(),
    endsAt: z.string().datetime().nullable().optional(),
  })
  // image banners need an image; hero banners need a headline.
  .refine((d) => (d.variant === 'image' ? !!d.imageUrl : !!d.headline), {
    message: 'image banners require imageUrl; hero banners require a headline',
  })

const patchSchema = z.object({ id: z.string().uuid(), isActive: z.boolean() })

export async function GET() {
  const gate = await requireAdmin()
  if (gate.error) return gate.error
  const admin = await createAdminClient()
  const { data } = await admin
    .from('cms_banners')
    .select(
      'id, slot, variant, image_url, link, headline, subline, cta_label, cta_href, discount_pct, locale, starts_at, ends_at, is_active, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(200)
  // Live catalog max discount — surfaced so the admin keeps the hero figure
  // honest (item 8 trust rule).
  const maxDiscountPct = await getMaxDiscountPct()
  return NextResponse.json({ banners: data ?? [], maxDiscountPct })
}

/** Audit M11 — the CMS writes are admin mutations like any other: no agent token, the admin limiter. */
async function mutationGate(route: string): Promise<{ userId: string; error?: undefined } | { userId?: undefined; error: NextResponse }> {
  const gate = await requireAdmin()
  if (gate.error) return gate
  const delegated = await requireNotDelegated(route)
  if (delegated) return { error: delegated }
  const rl = await enforce(limiters.adminMutation, `admin:${gate.userId}`)
  if (!rl.ok) return { error: tooManyRequests(rl.retryAfter) }
  return { userId: gate.userId }
}

export async function POST(request: NextRequest) {
  const gate = await mutationGate('POST /admin/cms')
  if (gate.error) return gate.error

  const json = await request.json().catch(() => null)
  const parsed = createSchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const admin = await createAdminClient()
  const row = {
    slot: d.slot,
    variant: d.variant,
    image_url: d.variant === 'image' ? (d.imageUrl ?? null) : null,
    link: d.link ?? null,
    headline: d.variant === 'hero' ? (d.headline ?? null) : null,
    subline: d.variant === 'hero' ? (d.subline ?? null) : null,
    cta_label: d.variant === 'hero' ? (d.ctaLabel ?? null) : null,
    cta_href: d.variant === 'hero' ? (d.ctaHref ?? null) : null,
    discount_pct: d.variant === 'hero' ? (d.discountPct ?? null) : null,
    locale: d.locale ?? null,
    starts_at: d.startsAt ?? null,
    ends_at: d.endsAt ?? null,
    is_active: true,
  }
  const { data: created, error } = await admin.from('cms_banners').insert(row).select('id').single()
  if (error) return serverError('[admin/cms POST]', error)
  // §7 — every admin mutation is audit-logged: a banner renders on public pages.
  await writeAudit(admin, request, { actorId: gate.userId, action: 'cms_banner_create', entity: 'cms_banners', entityId: created.id, before: null, after: row })
  return NextResponse.json({ ok: true, banner: created })
}

export async function PATCH(request: NextRequest) {
  const gate = await mutationGate('PATCH /admin/cms')
  if (gate.error) return gate.error

  const json = await request.json().catch(() => null)
  const parsed = patchSchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const { data: before } = await admin.from('cms_banners').select('id, slot, is_active').eq('id', parsed.data.id).maybeSingle()
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { error } = await admin
    .from('cms_banners')
    .update({ is_active: parsed.data.isActive, updated_at: new Date().toISOString() })
    .eq('id', parsed.data.id)
  if (error) return serverError('[admin/cms PATCH]', error)
  await writeAudit(admin, request, {
    actorId: gate.userId,
    action: 'cms_banner_update',
    entity: 'cms_banners',
    entityId: parsed.data.id,
    before: { slot: before.slot, is_active: before.is_active },
    after: { slot: before.slot, is_active: parsed.data.isActive },
  })
  return NextResponse.json({ ok: true })
}
