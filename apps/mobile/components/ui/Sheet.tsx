import { useEffect, useState, type ReactNode } from 'react'
import { Animated, Dimensions, Modal, PanResponder, Pressable, Text, View } from 'react-native'

export type SheetDetent = 'medium' | 'large'
const HEIGHT_OF: Record<SheetDetent, number> = { medium: 0.5, large: 0.9 }

/** A mutable cell the gesture handlers close over (read only in handlers and effects, never in render). */
function cell<T>(initial: T) {
  let current = initial
  return { get: () => current, set: (next: T) => { current = next } }
}

/**
 * E13 FR-13.5 — the ui-v3 Sheet's native twin: a bottom sheet with two
 * detents (medium ≈ half the screen, large ≈ 90 %). Drag the handle up to
 * expand, down to shrink or dismiss; the backdrop dismisses. Moves on the
 * native driver.
 */
export function Sheet({ visible, onClose, title, initialDetent = 'medium', children, testID = 'sheet' }: { visible: boolean; onClose: () => void; title: string; initialDetent?: SheetDetent; children: ReactNode; testID?: string }) {
  const screenH = Dimensions.get('window').height
  const full = screenH * HEIGHT_OF.large
  // translateY: 0 = large; (large − medium) = medium; full = off-screen.
  const offsetOf = (d: SheetDetent) => full - screenH * HEIGHT_OF[d]
  const y = useState(() => new Animated.Value(full))[0]
  const [{ detent, close, pan }] = useState(() => {
    const detent = cell<SheetDetent>(initialDetent)
    const close = cell(onClose)
    const pan = PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 6,
      onPanResponderMove: (_e, g) => y.setValue(Math.max(0, offsetOf(detent.get()) + g.dy)),
      onPanResponderRelease: (_e, g) => {
        const at = offsetOf(detent.get()) + g.dy
        if (g.dy > 80 && detent.get() === 'medium') { Animated.timing(y, { toValue: full, duration: 180, useNativeDriver: true }).start(() => close.get()()); return }
        const next: SheetDetent = at < (offsetOf('medium') / 2) ? 'large' : 'medium'
        detent.set(next)
        Animated.spring(y, { toValue: offsetOf(next), useNativeDriver: true, bounciness: 2 }).start()
      },
    })
    return { detent, close, pan }
  })

  useEffect(() => { close.set(onClose) }, [close, onClose])

  useEffect(() => {
    if (!visible) return
    detent.set(initialDetent)
    Animated.spring(y, { toValue: offsetOf(initialDetent), useNativeDriver: true, bounciness: 2 }).start()
  }, [visible]) // eslint-disable-line react-hooks/exhaustive-deps -- once per opening

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} className="flex-1 bg-black/40" accessibilityLabel={title} />
      <Animated.View style={{ height: full, transform: [{ translateY: y }] }} className="absolute bottom-0 left-0 right-0 rounded-t-2xl bg-surface" testID={testID}>
        <View {...pan.panHandlers} className="items-center pb-2 pt-3" accessibilityRole="adjustable" accessibilityHint={title}>
          <View className="h-1.5 w-10 rounded-full bg-gray-300" />
        </View>
        <Text className="px-4 pb-2 text-base font-semibold text-foreground">{title}</Text>
        <View className="flex-1 px-4">{children}</View>
      </Animated.View>
    </Modal>
  )
}
