import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AGENT_SETTING_DEFS, agentSettingDefault, type AgentSettingKey, type BenchmarkGates } from '@amclub/shared'

/**
 * S3.2 — the fair-price switches and privacy gates, read in ONE query and validated against the closed registry (a
 * malformed row reads as its default). The formula is BENCHMARK_VERSION in @amclub/shared, never a setting.
 */
export interface BenchmarkSettings {
  computeEnabled: boolean
  displayEnabled: boolean
  gates: BenchmarkGates
}

const KEYS = ['benchmark_compute_enabled', 'benchmark_display_enabled', 'benchmark_min_sample', 'benchmark_min_providers', 'benchmark_min_buyers', 'benchmark_max_provider_share_bps'] as const satisfies readonly AgentSettingKey[]

export async function getBenchmarkSettings(admin: SupabaseClient): Promise<BenchmarkSettings> {
  const { data } = await admin.from('agent_settings').select('key, value').in('key', [...KEYS])
  const raw = new Map(((data ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value]))
  const read = <T>(key: (typeof KEYS)[number]): T => {
    const def = AGENT_SETTING_DEFS[key]
    const parsed = raw.has(key) ? def.schema.safeParse(raw.get(key)) : null
    return (parsed?.success ? parsed.data : agentSettingDefault(key)) as T
  }
  return {
    computeEnabled: read<boolean>('benchmark_compute_enabled'),
    displayEnabled: read<boolean>('benchmark_display_enabled'),
    gates: {
      minSample: read<number>('benchmark_min_sample'),
      minProviders: read<number>('benchmark_min_providers'),
      minBuyers: read<number>('benchmark_min_buyers'),
      maxProviderShareBps: read<number>('benchmark_max_provider_share_bps'),
    },
  }
}
