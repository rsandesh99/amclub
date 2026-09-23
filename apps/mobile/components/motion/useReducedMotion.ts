import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'

/** The OS "reduce motion" setting (null until known). Signature motions jump straight to their final state when it is on. */
export function useReducedMotion(): boolean | null {
  const [reduced, setReduced] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (alive) setReduced(v) }).catch(() => { if (alive) setReduced(false) })
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => setReduced(v))
    return () => { alive = false; sub.remove() }
  }, [])
  return reduced
}
