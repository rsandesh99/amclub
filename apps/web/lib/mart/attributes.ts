import 'server-only'
import type { MartAttributeDef } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { createPublicClient } from '@/lib/supabase/server'

type Db = Awaited<ReturnType<typeof createAdminClient>> | ReturnType<typeof createPublicClient>

/**
 * E16 N40 — a category's typed attribute definitions (mart_category_attributes,
 * staged 0069; public read). Mart-only: nothing in the services path calls it.
 */
const ATTRIBUTE_COLS = 'key, label_i18n, type, unit, options, facetable, required, sort'

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapDef(r: any): MartAttributeDef {
  return {
    key: r.key,
    label_i18n: r.label_i18n ?? { en: r.key },
    type: r.type,
    unit: r.unit ?? null,
    options: Array.isArray(r.options) ? (r.options as unknown[]).map(String) : null,
    facetable: !!r.facetable,
    required: !!r.required,
    sort: Number(r.sort ?? 0),
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function listCategoryAttributes(db: Db, slug: string): Promise<MartAttributeDef[]> {
  const { data, error } = await db.from('mart_category_attributes').select(ATTRIBUTE_COLS).eq('category_slug', slug).order('sort', { ascending: true })
  if (error) {
    console.error('[listCategoryAttributes]', error.message)
    return []
  }
  return (data ?? []).map(mapDef)
}

/** Public read (anon client) — product page, browse facets, the wizard's inputs. */
export function publicCategoryAttributes(slug: string): Promise<MartAttributeDef[]> {
  return listCategoryAttributes(createPublicClient(), slug)
}
