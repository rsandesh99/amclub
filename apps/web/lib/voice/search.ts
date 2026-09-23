import 'server-only'
import { createAdminClient } from '@/lib/supabase/server'
import { getAgentSetting } from '@/lib/agent/settings'
import { isOnForEveryone } from '@/lib/experiments'
import { voiceLanguageAllowed, type VoiceLanguageEval } from '@amclub/shared'

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

/**
 * E14 FR-14.5 — may the mic answer in this (STT-detected) language? Listed in
 * `voice_search_languages` AND its recorded eval passes (shared
 * `voiceLanguageAllowed`). A failing read is "no".
 */
export async function isVoiceLanguageAllowed(admin: Awaited<ReturnType<typeof createAdminClient>>, languageCode: string): Promise<boolean> {
  try {
    const [listed, evals] = await Promise.all([getAgentSetting(admin, 'voice_search_languages'), getAgentSetting(admin, 'voice_language_evals')])
    return voiceLanguageAllowed(languageCode, listed as string[], evals as Record<string, VoiceLanguageEval>)
  } catch {
    return false
  }
}
