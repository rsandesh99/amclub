import { describe, expect, it } from 'vitest'
import {
  AGENT_NAMES,
  AGENT_SETTING_KEYS,
  AGENT_SETTING_DEFS,
  agentSettingDefault,
  agentSettingPutSchema,
  killSwitchAgentsEnabled,
  parseAgentSetting,
} from '../index'

/**
 * The agent config registry is a CLOSED registry (ADR-009 §7): an unknown key
 * can never be written, and every value is validated by its declared schema.
 * These are the properties the admin console and the runner rely on.
 */

describe('agent settings registry', () => {
  it('every launch default validates against its own schema', () => {
    for (const key of AGENT_SETTING_KEYS) {
      const def = AGENT_SETTING_DEFS[key]
      expect(def.schema.safeParse(def.default).success).toBe(true)
    }
  })

  it('agents ship dark: every agent defaults to false', () => {
    const enabled = agentSettingDefault('agents_enabled') as Record<string, boolean>
    for (const name of AGENT_NAMES) expect(enabled[name]).toBe(false)
  })

  it('rejects an unknown key (closed registry)', () => {
    expect(parseAgentSetting('payout_auto_release', true).ok).toBe(false)
    expect(agentSettingPutSchema.safeParse({ key: 'nope', value: 1 }).success).toBe(false)
  })

  it('validates a known key\'s value', () => {
    expect(parseAgentSetting('budget_run_paise', 2500).ok).toBe(true)
    expect(parseAgentSetting('budget_run_paise', -1).ok).toBe(false)
    expect(parseAgentSetting('cohort_user_ids', ['not-a-uuid']).ok).toBe(false)
    expect(parseAgentSetting('cohort_user_ids', ['00000000-0000-0000-0000-000000000000']).ok).toBe(true)
  })

  it('the kill switch turns every agent off', () => {
    const killed = killSwitchAgentsEnabled()
    for (const name of AGENT_NAMES) expect(killed[name]).toBe(false)
    expect(parseAgentSetting('agents_enabled', killed).ok).toBe(true)
  })
})
