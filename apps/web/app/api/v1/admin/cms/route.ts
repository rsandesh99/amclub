import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { serverError } from '@/lib/api/errors'

const createSchema = z.object({
  slot: z.string().trim().min(1).max(40),
  imageUrl: z.string().url(),
  link: z.string().url().optional(),
  locale: z.enum(['en', 'hi']).nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
})

const patchSchema = z.object({ id: z.string().uuid(), isActive: z.boolean() })

async function requireAdmin() {
  const user = await getSessionUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!user.roles.includes('admin') && !user.roles.includes('ops')) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { user }
}

export async function GET() {
  const gate = await requireAdmin()
  if (gate.error) return gate.error
  const admin = await createAdminClient()
  const { data } = await admin
    .from('cms_banners')
    .select('id, slot, image_url, link, locale, starts_at, ends_at, is_active, created_at')
    .order('created_at', { ascending: false })
    .limit(200)
  return NextResponse.json({ banners: data ?? [] })
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
      image_url: d.imageUrl,
      link: d.link ?? null,
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
