import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { packageSchema } from '@amclub/shared'
import { toPackageRow, slugify } from '@/lib/partner/packageRow'
import { revalidateCatalog } from '@/lib/catalog/revalidate'

export async function POST(request: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!user.roles.includes('provider')) {
    return NextResponse.json({ error: 'Provider role required' }, { status: 403 })
  }

  const json = await request.json().catch(() => null)
  const parsed = packageSchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  // RLS session client — the provider crud-own policy enforces ownership.
  const supabase = await createClient()

  const { data: provider } = await supabase
    .from('provider_profiles')
    .select('id, slug')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!provider) {
    return NextResponse.json({ error: 'No provider profile' }, { status: 404 })
  }

  const { data: category } = await supabase
    .from('categories')
    .select('id')
    .eq('slug', d.category_slug)
    .maybeSingle()
  if (!category) {
    return NextResponse.json({ error: 'Invalid category' }, { status: 422 })
  }

  const slug = `${slugify(d.title)}-${Math.random().toString(36).slice(2, 7)}`

  const { data: pkg, error } = await supabase
    .from('packages')
    .insert({
      provider_id: provider.id,
      slug,
      ...toPackageRow(d, category.id),
    })
    .select('id, slug')
    .single()

  if (error || !pkg) {
    console.error('[partner/packages POST]', error)
    return NextResponse.json({ error: error?.message ?? 'Create failed' }, { status: 500 })
  }

  // Make the new listing appear on public ISR pages within seconds.
  if (d.status === 'active') {
    revalidateCatalog({ categorySlug: d.category_slug, providerSlug: provider.slug })
  }

  return NextResponse.json({ id: pkg.id, slug: pkg.slug, status: d.status })
}
