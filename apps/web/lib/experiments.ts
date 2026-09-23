import 'server-only'
import {
  EXPERIENCE_FLAGS,
  experienceFlagEnvVar,
  isExperienceOn,
  parseExperienceSetting,
  type ExperienceFlag,
} from '@amclub/shared'

/**
 * Experience v3 flags (PRD §7.9), evaluated on the server from env
 * (`EXP_V3_<FLAG>` = off | on | 0–100) plus the `EXP_V3_COHORT` allowlist.
 * Default OFF — every v3 surface ships dark. See @amclub/shared experiments.ts.
 */
function cohort(): Set<string> {
  return new Set((process.env['EXP_V3_COHORT'] ?? '').split(',').map((s) => s.trim()).filter(Boolean))
}

export function experienceSetting(flag: ExperienceFlag) {
  return parseExperienceSetting(process.env[experienceFlagEnvVar(flag)])
}

/** On for every visitor — the only mode a static (anonymous, ISR) page can honour. */
export function isOnForEveryone(flag: ExperienceFlag): boolean {
  return experienceSetting(flag).mode === 'on'
}

/** On for this signed-in user (percentage bucket or cohort), or for everyone. */
export function isOnFor(flag: ExperienceFlag, userId: string | null | undefined): boolean {
  return isExperienceOn(flag, experienceSetting(flag), { userId: userId ?? null, inCohort: !!userId && cohort().has(userId) })
}

/** Every flag that is on for this user — for /profile/me (mobile) and analytics props. */
export function enabledExperiences(userId: string | null | undefined): ExperienceFlag[] {
  return EXPERIENCE_FLAGS.filter((f) => isOnFor(f, userId))
}
