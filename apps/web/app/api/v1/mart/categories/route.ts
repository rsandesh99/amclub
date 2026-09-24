import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { martApiGate } from '@/lib/mart/gate'
import { listMartCategories } from '@/lib/mart/config'
import { publicCategoryAttributes } from '@/lib/mart/attributes'

/**
 * Active Mart categories (BIS-blocked ones are listed with the flag so UIs can
 * grey them out). `?attributes=<slug>` adds that category's typed attribute
 * definitions (E16 N40) — the listing wizard's inputs.
 */
export async function GET(request: NextRequest) {
  const gate = martApiGate()
  if (gate) return gate
  const slug = request.nextUrl.searchParams.get('attributes')
  const [categories, attributes] = await Promise.all([
    listMartCategories(),
    slug && /^[a-z0-9-]{1,60}$/.test(slug) ? publicCategoryAttributes(slug) : Promise.resolve(null),
  ])
  return NextResponse.json(
    {
      categories: categories.map((c) => ({ slug: c.slug, nameI18n: c.name_i18n, returnWindowHours: c.return_window_hours, bisBlocked: c.bis_blocked })),
      ...(attributes ? { attributes } : {}),
    },
    { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
  )
}
