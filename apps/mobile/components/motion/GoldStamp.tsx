import { useEffect, useState } from 'react'
import { Animated, Easing, Text, View } from 'react-native'
import { GOLD_STAMP_PHASES_MS } from '@amclub/shared'
import { confirmHaptic } from '@/lib/haptics'
import { useReducedMotion } from './useReducedMotion'

/**
 * FRONTEND.md §3.1 GOLD STAMP on the native thread (E13 FR-13.5): the seal
 * presses in (1.25 → 0.94), settles with the paper-indent bounce (→ 1), one
 * metallic sweep — inside the shared 700 ms budget, with the confirm haptic.
 * Reduced motion: the final seal at once. `onDone` fires when it has landed.
 */
export function GoldStamp({ label, onDone, testID = 'gold-stamp' }: { label: string; onDone?: () => void; testID?: string }) {
  const reduced = useReducedMotion()
  const scale = useState(() => new Animated.Value(1.25))[0]
  const opacity = useState(() => new Animated.Value(0))[0]
  const sweep = useState(() => new Animated.Value(-1))[0]

  useEffect(() => {
    if (reduced === null) return
    if (reduced) {
      scale.setValue(1); opacity.setValue(1); sweep.setValue(1)
      onDone?.()
      return
    }
    confirmHaptic()
    const anim = Animated.sequence([
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: GOLD_STAMP_PHASES_MS.press, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 0.94, duration: GOLD_STAMP_PHASES_MS.press, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]),
      Animated.timing(scale, { toValue: 1, duration: GOLD_STAMP_PHASES_MS.settle, easing: Easing.out(Easing.back(2)), useNativeDriver: true }),
      Animated.timing(sweep, { toValue: 1, duration: GOLD_STAMP_PHASES_MS.sweep, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ])
    anim.start(({ finished }) => { if (finished) onDone?.() })
    return () => anim.stop()
  }, [reduced]) // eslint-disable-line react-hooks/exhaustive-deps -- runs once the reduced-motion setting is known

  return (
    <View className="items-center justify-center" testID={testID} accessibilityRole="image" accessibilityLabel={label}>
      <Animated.View style={{ opacity, transform: [{ scale }] }} className="h-24 w-24 items-center justify-center overflow-hidden rounded-full border-4 border-[#C9A227] bg-[#F4E4B0]">
        <Text className="text-4xl font-bold text-[#8A6A12]">✓</Text>
        <Animated.View
          pointerEvents="none"
          style={{ position: 'absolute', top: 0, bottom: 0, width: 28, backgroundColor: 'rgba(255,255,255,0.45)', transform: [{ translateX: sweep.interpolate({ inputRange: [-1, 1], outputRange: [-70, 70] }) }, { rotate: '20deg' }] }}
        />
      </Animated.View>
      <Text className="mt-3 text-base font-semibold text-foreground">{label}</Text>
    </View>
  )
}
