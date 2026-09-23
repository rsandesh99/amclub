import { useEffect, useState } from 'react'
import { Animated, Easing, Modal, Pressable, Text, View } from 'react-native'
import { PAISA_MOMENT_PHASES_MS } from '@amclub/shared'
import { useReducedMotion } from './useReducedMotion'

/**
 * FRONTEND.md §3.1 PAISA MOMENT on the native thread (E13 FR-13.5): emerald
 * screen, the gold coin drops and flips, lands as a tick, the amount (the
 * server's formatted text — never computed here) fades up; hands back inside
 * the shared 900 ms budget, or on a tap. Reduced motion: the final frame, then
 * hand back.
 */
export function PaisaMoment({ visible, title, amountText, onDone }: { visible: boolean; title: string; amountText: string; onDone: () => void }) {
  const reduced = useReducedMotion()
  const drop = useState(() => new Animated.Value(0))[0]
  const flip = useState(() => new Animated.Value(0))[0]
  const amount = useState(() => new Animated.Value(0))[0]

  useEffect(() => {
    if (!visible || reduced === null) return
    if (reduced) {
      drop.setValue(1); flip.setValue(1); amount.setValue(1)
      const t = setTimeout(onDone, PAISA_MOMENT_PHASES_MS.hold)
      return () => clearTimeout(t)
    }
    const anim = Animated.sequence([
      Animated.timing(drop, { toValue: 1, duration: PAISA_MOMENT_PHASES_MS.drop, easing: Easing.out(Easing.bounce), useNativeDriver: true }),
      Animated.timing(flip, { toValue: 1, duration: PAISA_MOMENT_PHASES_MS.land, useNativeDriver: true }),
      Animated.timing(amount, { toValue: 1, duration: PAISA_MOMENT_PHASES_MS.amount, useNativeDriver: true }),
      Animated.delay(PAISA_MOMENT_PHASES_MS.hold),
    ])
    anim.start(({ finished }) => { if (finished) onDone() })
    return () => anim.stop()
  }, [visible, reduced]) // eslint-disable-line react-hooks/exhaustive-deps -- once per showing

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDone}>
      <Pressable onPress={onDone} className="flex-1 items-center justify-center bg-[#0F3B2E]" testID="paisa-moment" accessibilityLabel={`${title} ${amountText}`}>
        <View className="items-center">
          <Animated.View
            style={{
              opacity: drop,
              transform: [
                { translateY: drop.interpolate({ inputRange: [0, 1], outputRange: [-120, 0] }) },
                { rotateY: flip.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) },
              ],
            }}
            className="h-24 w-24 items-center justify-center rounded-full border-4 border-[#E7C766] bg-[#C9A227]"
          >
            <Text className="text-4xl font-bold text-[#0F3B2E]">✓</Text>
          </Animated.View>
          <Animated.View style={{ opacity: amount }} className="mt-6 items-center">
            <Text className="text-sm text-[#F6F1E4]">{title}</Text>
            <Text className="mt-1 text-4xl font-bold text-[#E7C766]">{amountText}</Text>
          </Animated.View>
        </View>
      </Pressable>
    </Modal>
  )
}
