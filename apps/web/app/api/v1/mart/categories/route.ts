import { NextResponse } from 'next/server'
import { martApiGate } from '@/lib/mart/gate'
import { listMartCategories } from '@/lib/mart/config'

/** Active Mart categories (BIS-blocked ones are listed with the flag so UIs can grey them out). */
export async function GET() {
  const gate = martApiGate()
  if (gate) return gate
  const categories = await listMartCategories()
  return NextResponse.json(
    { categories: categories.map((c) => ({ slug: c.slug, nameI18n: c.name_i18n, returnWindowHours: c.return_window_hours, bisBlocked: c.bis_blocked })) },
    { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
  )
}
