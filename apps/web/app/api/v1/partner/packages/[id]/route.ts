import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { packageSchema } from '@amclub/shared'
import { toPackageRow } from '@/lib/partner/packageRow'
import { revalidateCatalog } from '@/lib/catalog/revalidate'
import { serverError } from '@/lib/api/errors'

// Edit accepts the full package shape; status may also be 'paused'.
const editSchema = packageSchema.extend({
  status: z.enum(['draft', 'active', 'paused']).default('active'),
})

async function ownPackage(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  packageId: string,
): Promise<{ ok: boolean; providerSlug?: string; packageSlug?: string; categorySlug?: string }> {
  const { data } = await supabase
    .from('packages')
    .select('id, slug, category:categories(slug), provider:provider_profiles!inner(user_id, slug)')
    .eq('id', packageId)
    .maybeSingle()
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const ownerId = (data as any)?.provider?.user_id
  if (!data || ownerId !== userId) return { ok: false }
  // Slugs so every mutation can purge the exact public pages it affects
  // (/p/{provider}, /p/{provider}/{package}, /services/{category}).
  return {
    ok: true,
    providerSlug: (data as any)?.provider?.slug,
    packageSlug: (data as any)?.slug,
    categorySlug: (data as any)?.category?.slug,
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const json = await request.json().catch(() => null)
  const parsed = editSchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  const supabase = await createClient()
  const own = await ownPackage(supabase, user.id, id)
  if (!own.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { data: category } = await supabase
    .from('categories')
    .select('id')
    .eq('slug', d.category_slug)
    .maybeSingle()
  if (!category) return NextResponse.json({ error: 'Invalid category' }, { status: 422 })

  const { error } = await supabase
    .from('packages')
    .update(toPackageRow({ ...d, status: d.status === 'paused' ? 'active' : d.status }, category.id))
    .eq('id', id)

  // toPackageRow forces status from the draft|active union; set paused explicitly.
  if (!error && d.status === 'paused') {
    await supabase.from('packages').update({ status: 'paused' }).eq('id', id)
  }

  if (error) return serverError('[partner/packages PATCH]', error)
  revalidateCatalog({
    categorySlug: d.category_slug,
    ...(own.providerSlug ? { providerSlug: own.providerSlug } : {}),
    ...(own.packageSlug ? { packageSlug: own.packageSlug } : {}),
  })
  // Category may have CHANGED in this edit — purge the old one too.
  if (own.categorySlug && own.categorySlug !== d.category_slug) {
    revalidateCatalog({ categorySlug: own.categorySlug })
  }
  return NextResponse.json({ id, status: d.status })
}

const statusPatchSchema = z.object({ status: z.enum(['active', 'paused', 'draft']) })

/** Lightweight status toggle (pause/activate) without a full edit payload. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const json = await request.json().catch(() => null)
  const parsed = statusPatchSchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid status' }, { status: 422 })

  const supabase = await createClient()
  const own = await ownPackage(supabase, user.id, id)
  if (!own.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const { error } = await supabase.from('packages').update({ status: parsed.data.status }).eq('id', id)
  if (error) return serverError('[partner/packages POST status]', error)
  revalidateCatalog({
    ...(own.categorySlug ? { categorySlug: own.categorySlug } : {}),
    ...(own.providerSlug ? { providerSlug: own.providerSlug } : {}),
    ...(own.packageSlug ? { packageSlug: own.packageSlug } : {}),
  })
  return NextResponse.json({ id, status: parsed.data.status })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const supabase = await createClient()
  const own = await ownPackage(supabase, user.id, id)
  if (!own.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  // Soft delete (§2.5 rule 4) — never hard-delete provider content.
  const { error } = await supabase
    .from('packages')
    .update({ status: 'removed', deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) return serverError('[partner/packages DELETE]', error)
  revalidateCatalog({
    ...(own.categorySlug ? { categorySlug: own.categorySlug } : {}),
    ...(own.providerSlug ? { providerSlug: own.providerSlug } : {}),
    ...(own.packageSlug ? { packageSlug: own.packageSlug } : {}),
  })
  return NextResponse.json({ id, deleted: true })
}
