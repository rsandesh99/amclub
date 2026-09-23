import * as Haptics from 'expo-haptics'
import { currentMobileRole } from './role'

/**
 * PRD Experience v3 E13 FR-13.5 — one light haptic on every primary confirm
 * (pay, accept, send quote). Only while the `mobile` experience is on (the
 * role store is set only then); never throws — a device without a haptic
 * engine just stays still.
 */
export function confirmHaptic(): void {
  if (currentMobileRole() === null) return
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined)
}
