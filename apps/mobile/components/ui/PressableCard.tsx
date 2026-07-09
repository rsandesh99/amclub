/**
 * MOBILE_PARITY §1 — elevation + press feedback for tappable cards.
 * RN has no CSS box-shadow or :active, so this wraps Pressable: resting
 * elevation (≈ web shadow-resting) and on press the card settles (lower
 * shadow + slight scale + opacity). The scale is gated on the OS
 * reduce-motion setting (parity with web's motion-safe: rules); shadow and
 * opacity feedback remain for everyone.
 *
 * Visual card styles (border/background/padding) live on the inner View via
 * `className` — keeping NativeWind classes and the animated style function on
 * separate nodes avoids interop conflicts.
 */
import { useEffect, useState } from 'react'
import { AccessibilityInfo, Pressable, View, type PressableProps } from 'react-native'
import { cardShadow, cardShadowPressed } from '@/lib/theme'

export function PressableCard({
  className,
  children,
  ...props
}: Omit<PressableProps, 'style'> & { className?: string; children?: React.ReactNode }) {
  const [reduceMotion, setReduceMotion] = useState(false)

  useEffect(() => {
    let mounted = true
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (mounted) setReduceMotion(v) })
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion)
    return () => { mounted = false; sub.remove() }
  }, [])

  return (
    <Pressable
      {...props}
      style={({ pressed }) => [
        pressed ? cardShadowPressed : cardShadow,
        pressed && !reduceMotion ? { transform: [{ scale: 0.98 }] } : null,
        pressed ? { opacity: 0.96 } : null,
      ]}
    >
      <View className={className}>{children}</View>
    </Pressable>
  )
}
