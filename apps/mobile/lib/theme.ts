/**
 * JS-side design tokens — the single mobile source for colors that must be
 * passed as props (Ionicons `color`, ActivityIndicator, shadows), where
 * NativeWind classes can't reach. MUST stay in sync with tailwind.config.js
 * (which itself hand-syncs with apps/web — see docs/MOBILE_PARITY.md).
 */
import { Platform, type ViewStyle } from 'react-native'

export const colors = {
  primary: '#1B4D3E',
  primaryStrong: '#143F33',
  accent: '#F4A300',
  success: '#14724A',
  trust: '#155C9E',
  verified: '#155C9E',
  danger: '#C73E3E',
  warning: '#92400E',
  background: '#FAFAF7',
  surface: '#FFFFFF',
  border: '#E6E7E3',
  muted: '#F3F4F1',
  foreground: '#1A1D1A',
  foregroundSecondary: '#5C645C',
  white: '#FFFFFF',
} as const

/** ≈ web `shadow-resting` — cards at rest. Android: elevation; iOS: shadow. */
export const cardShadow: ViewStyle = Platform.select({
  android: { elevation: 2 },
  default: {
    shadowColor: '#1A1D1A',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
  },
})!

/** ≈ web `shadow-pressed` — pressed cards sit lower, not higher. */
export const cardShadowPressed: ViewStyle = Platform.select({
  android: { elevation: 1 },
  default: {
    shadowColor: '#1A1D1A',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 1.5,
  },
})!
