import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AGENT_ENABLED } from '@/lib/flags'
import { getAgentSetting, isAgentEnabledForUser } from '@/lib/agent/settings'
import { GRIEVANCE_SLA, SUPPORT_CONTACT } from '@/lib/legal/grievance'

/** AGENT_ENABLED + agents_enabled.support + cohort — for THIS user (S2.3). */
export async function isSupportEnabledFor(admin: SupabaseClient, userId: string): Promise<boolean> {
  if (!AGENT_ENABLED) return false
  return isAgentEnabledForUser(admin, 'support', userId)
}

export interface SupportSettings {
  escalateAfterTurns: number
  nudgeCooldownHours: number
  opsQuietHours: { from: string; to: string } | null
}

export async function getSupportSettings(admin: SupabaseClient): Promise<SupportSettings> {
  const [esc, cool, quiet] = await Promise.all([getAgentSetting(admin, 'support_escalate_after_turns'), getAgentSetting(admin, 'support_nudge_cooldown_hours'), getAgentSetting(admin, 'support_ops_quiet_hours')])
  const int = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : d)
  const q = quiet as { from?: unknown; to?: unknown } | null
  return {
    escalateAfterTurns: int(esc, 2, 1, 5),
    nudgeCooldownHours: int(cool, 24, 1, 168),
    opsQuietHours: q && typeof q.from === 'string' && typeof q.to === 'string' ? { from: q.from, to: q.to } : null,
  }
}

/** The SLA + contact line every template quotes — from the ONE source (lib/legal/grievance.ts). */
export const SUPPORT_SLA = { acknowledge_hours: GRIEVANCE_SLA.acknowledgeHours, resolve_days: GRIEVANCE_SLA.resolveDays } as const
export const SUPPORT_CONTACT_LINE = `${SUPPORT_CONTACT.email} / ${SUPPORT_CONTACT.whatsapp}`

/** IST "HH:MM" now, for the ops quiet-hours window. */
export function istClock(d = new Date()): string {
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000)
  return `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')}`
}

export function inQuietHours(window: { from: string; to: string } | null, now = new Date()): boolean {
  if (!window) return false
  const clock = istClock(now)
  return window.from <= window.to ? clock >= window.from && clock < window.to : clock >= window.from || clock < window.to
}
