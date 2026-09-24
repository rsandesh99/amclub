import 'server-only'
import { randomUUID } from 'node:crypto'
import { after } from 'next/server'
import { SEARCH_SAMPLE_PCT_DEFAULT, normaliseSearch, sampledSearch, synonymKey, type SearchV2 } from '@amclub/shared'
import { createAdminClient, createPublicClient } from '@/lib/supabase/server'
import { getAgentSetting } from '@/lib/agent/settings'

/**
 * E15 FR-15.3 (F5) — one `search_id` per results page. A sample (setting
 * `search_telemetry_sample_pct`, default 20 %) is written to `search_queries`
 * after the response is sent: the normalised parameters and the result count,
 * never a user id. The id itself rides the result links (`?sid=`) so the order
 * a search produced can be tied back to it. Best-effort throughout.
 */
export function recordSearchPage(s: SearchV2, resultCount: number): string {
  const searchId = randomUUID()
  const run = async () => {
    try {
      const admin = await createAdminClient()
      const raw = await getAgentSetting(admin, 'search_telemetry_sample_pct').catch(() => SEARCH_SAMPLE_PCT_DEFAULT)
      const pct = typeof raw === 'number' ? raw : SEARCH_SAMPLE_PCT_DEFAULT
      if (!sampledSearch(searchId, pct)) return
      const { query, params } = normaliseSearch(s)
      await admin.from('search_queries').insert({ id: searchId, query_norm: query, params, result_count: resultCount })
    } catch {
      /* telemetry is best-effort */
    }
  }
  try {
    after(run)
  } catch {
    void run()
  }
  return searchId
}

/**
 * E15 FR-15.4 (F6) — a REVIEWED synonym for the whole query (exact, folded):
 * the curated category / service it means. Search reads reviewed rows only
 * (the policy returns nothing else); any failure is "no synonym".
 */
export async function reviewedSynonymFor(query: string | undefined): Promise<{ category: string; service: string | null } | null> {
  const key = query ? synonymKey(query) : ''
  if (!key || key.length > 80) return null
  try {
    const { data, error } = await createPublicClient().from('service_synonyms').select('category_slug, service_slug').eq('term_key', key).eq('reviewed', true).limit(1).maybeSingle()
    if (error || !data) return null
    return { category: data.category_slug as string, service: (data.service_slug as string | null) ?? null }
  } catch {
    return null
  }
}
