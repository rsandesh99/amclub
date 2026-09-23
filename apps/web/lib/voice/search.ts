import 'server-only'
import { createAdminClient } from '@/lib/supabase/server'
import { getAgentSetting } from '@/lib/agent/settings'
import { isOnForEveryone } from '@/lib/experiments'

/**
 * Experience v3 E2b FR-2.5 (N5) — the catalog mic. Needs the search flag AND
 * agent_settings.voice_search_enabled (default off until the 30-query eval
 * passes). Server-evaluated; a failing read is "off".
 */
export async function isVoiceSearchOn(): Promise<boolean> {
  if (!isOnForEveryone('search')) return false
  if (!process.env['SUPABASE_SERVICE_ROLE_KEY']) return false
  try {
    return (await getAgentSetting(await createAdminClient(), 'voice_search_enabled')) === true
  } catch {
    return false
  }
}
