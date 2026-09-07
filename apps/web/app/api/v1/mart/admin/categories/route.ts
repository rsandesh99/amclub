import { NextResponse } from 'next/server'
import { martApiGate } from '@/lib/mart/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { listMartCategoriesAdmin } from '@/lib/mart/config'

/** Launch Gate — every Mart category (incl. inactive / BIS-blocked) for the config editor. */
export async function GET() {
  const gate = martApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const admin = await createAdminClient()
  const categories = await listMartCategoriesAdmin(admin)
  const { data: counts } = await admin.from('products').select('category_slug, status').is('deleted_at', null)
  const active: Record<string, number> = {}
  for (const p of counts ?? []) if (p.status === 'active') active[p.category_slug] = (active[p.category_slug] ?? 0) + 1
  return NextResponse.json(
    { categories: categories.map((c) => ({ ...c, active_listings: active[c.slug] ?? 0 })) },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
