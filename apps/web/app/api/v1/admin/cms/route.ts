import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
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
    locale: z.enum(['en', 'hi']).nullable().optional(),
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

export async function POST(request: NextRequest) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const json = await request.json().catch(() => null)
  const parsed = createSchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const admin = await createAdminClient()
  const { data: created, error } = await admin
    .from('cms_banners')
    .insert({
      slot: d.slot,
      variant: d.variant,
      image_url: d.variant === 'image' ? d.imageUrl : null,
      link: d.link ?? null,
      headline: d.variant === 'hero' ? d.headline : null,
      subline: d.variant === 'hero' ? (d.subline ?? null) : null,
      cta_label: d.variant === 'hero' ? (d.ctaLabel ?? null) : null,
      cta_href: d.variant === 'hero' ? (d.ctaHref ?? null) : null,
      discount_pct: d.variant === 'hero' ? (d.discountPct ?? null) : null,
      locale: d.locale ?? null,
      starts_at: d.startsAt ?? null,
      ends_at: d.endsAt ?? null,
      is_active: true,
    })
    .select('id')
    .single()
  if (error) return serverError('[admin/cms POST]', error)
  return NextResponse.json({ ok: true, banner: created })
}

export async function PATCH(request: NextRequest) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const json = await request.json().catch(() => null)
  const parsed = patchSchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const { error } = await admin
    .from('cms_banners')
    .update({ is_active: parsed.data.isActive, updated_at: new Date().toISOString() })
    .eq('id', parsed.data.id)
  if (error) return serverError('[admin/cms PATCH]', error)
  return NextResponse.json({ ok: true })
}
