'use client'

import { useEffect, useRef } from 'react'

/**
 * Cursor-follow 3D tilt from the handoff spec: target rotation clamped to ±3°,
 * spring-smoothed with a 0.08 lerp inside a rAF loop, applied imperatively so
 * mouse movement never re-renders React. Disabled under prefers-reduced-motion
 * and whenever `enabled` is false (exit/reveal phases).
 */
export function useCardTilt(enabled: boolean) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const spring = useRef({ rx: 0, ry: 0, tx: 0, ty: 0 })
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) return

    let raf = 0
    const loop = () => {
      const s = spring.current
      s.rx += (s.tx - s.rx) * 0.08
      s.ry += (s.ty - s.ry) * 0.08
      if (cardRef.current) {
        cardRef.current.style.transform = `perspective(900px) rotateX(${s.rx.toFixed(3)}deg) rotateY(${s.ry.toFixed(3)}deg)`
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  function onStageMouseMove(e: React.MouseEvent) {
    if (!enabledRef.current || !cardRef.current) return
    const r = cardRef.current.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    spring.current.ty = Math.max(-3, Math.min(3, ((e.clientX - cx) / (r.width / 2)) * 3))
    spring.current.tx = Math.max(-3, Math.min(3, (-(e.clientY - cy) / (r.height / 2)) * 3))
  }

  function onStageMouseLeave() {
    spring.current.tx = 0
    spring.current.ty = 0
  }

  return { cardRef, onStageMouseMove, onStageMouseLeave }
}
