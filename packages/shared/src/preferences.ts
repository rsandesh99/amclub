import { z } from 'zod'

/** N33 — display density (PRD §3.5). NULL/absent = the role default. */
export const UI_DENSITIES = ['comfortable', 'compact'] as const
export type UiDensity = (typeof UI_DENSITIES)[number]

export const preferencesPatchSchema = z.object({
  uiDensity: z.enum(UI_DENSITIES).nullable(),
})
export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>

/** The density a surface renders with: the user's choice, else the surface default. */
export function resolveDensity(pref: UiDensity | null | undefined, surface: 'buyer' | 'provider' | 'admin'): UiDensity {
  if (pref) return pref
  return surface === 'buyer' ? 'comfortable' : 'compact'
}
