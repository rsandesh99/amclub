import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AGENT_SETTING_DEFS, agentSettingDefault, type AgentSettingKey } from '@amclub/shared'

/**
 * S2.4 — the AMC Score switches and ranking constants, read in ONE query and validated against the closed
 * registry (a malformed row reads as its default). The formula is never a setting (ADR-010 §5).
 */
export interface ScoreSettings {
  computeEnabled: boolean
  cardEnabled: boolean
  rankEnabled: boolean
  rankThresholdPaise: number
  rankKBps: number
  nullPrior: number
  growthNudgeEnabled: boolean
}

const KEYS = ['score_compute_enabled', 'score_card_enabled', 'reliability_rank_enabled', 'reliability_rank_threshold_paise', 'reliability_rank_k_bps', 'score_null_prior', 'growth_nudge_enabled'] as const satisfies readonly AgentSettingKey[]

export async function getScoreSettings(admin: SupabaseClient): Promise<ScoreSettings> {
  const { data } = await admin.from('agent_settings').select('key, value').in('key', [...KEYS])
  const raw = new Map(((data ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value]))
  const read = <T>(key: (typeof KEYS)[number]): T => {
    const def = AGENT_SETTING_DEFS[key]
    const parsed = raw.has(key) ? def.schema.safeParse(raw.get(key)) : null
    return (parsed?.success ? parsed.data : agentSettingDefault(key)) as T
  }
  return {
    computeEnabled: read<boolean>('score_compute_enabled'),
    cardEnabled: read<boolean>('score_card_enabled'),
    rankEnabled: read<boolean>('reliability_rank_enabled'),
    rankThresholdPaise: read<number>('reliability_rank_threshold_paise'),
    rankKBps: read<number>('reliability_rank_k_bps'),
    nullPrior: read<number>('score_null_prior'),
    growthNudgeEnabled: read<boolean>('growth_nudge_enabled'),
  }
}
