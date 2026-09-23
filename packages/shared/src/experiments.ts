/**
 * Experience v3 rollout flags (PRD §7.9) — ONE closed registry. Each flag is
 * read from an env var on the server (`EXP_V3_<NAME>`): `off` (default),
 * `on`, or a percentage `0`–`100` evaluated per signed-in user with a stable
 * hash. A cohort allowlist (`EXP_V3_COHORT`, user ids) turns every flag on for
 * those users. Static public pages can only honour `on` (there is no user).
 * Server-evaluated like COUPONS/MART/AGENT: no client can flip a flag.
 */
export const EXPERIENCE_FLAGS = [
  'shell',
  'search',
  'trust',
  'packages',
  'checkout',
  'requirements',
  'compare',
  'orders',
  'home',
  'onboarding',
  'partner',
  'mobile',
  'locales',
] as const
export type ExperienceFlag = (typeof EXPERIENCE_FLAGS)[number]

export const experienceFlagEnvVar = (flag: ExperienceFlag): string => `EXP_V3_${flag.toUpperCase()}`

export type ExperienceFlagSetting = { mode: 'off' } | { mode: 'on' } | { mode: 'percent'; percent: number }

export function parseExperienceSetting(raw: string | undefined | null): ExperienceFlagSetting {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === 'on' || v === 'true' || v === '100') return { mode: 'on' }
  if (/^\d{1,3}$/.test(v)) {
    const n = Number(v)
    if (n <= 0) return { mode: 'off' }
    if (n >= 100) return { mode: 'on' }
    return { mode: 'percent', percent: n }
  }
  return { mode: 'off' }
}

/** Stable 0–99 bucket for (flag, subject) — FNV-1a, so the same user stays in or out across deploys. */
export function experienceBucket(flag: ExperienceFlag, subjectId: string): number {
  let h = 0x811c9dc5
  const s = `${flag}:${subjectId}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % 100
}

export function isExperienceOn(
  flag: ExperienceFlag,
  setting: ExperienceFlagSetting,
  subject: { userId?: string | null; inCohort?: boolean } = {},
): boolean {
  if (subject.inCohort) return true
  if (setting.mode === 'on') return true
  if (setting.mode === 'off') return false
  return subject.userId ? experienceBucket(flag, subject.userId) < setting.percent : false
}
