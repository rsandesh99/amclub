'use client'

import { useEffect, useState, type RefObject } from 'react'

/** A bar counts when its bottom edge is within this distance of the stack below it (floating trays sit ~80 px up). */
const NEAR_PX = 120

/**
 * How much of the bottom of the window is taken by what is pinned there: the
 * phone tab bar, sticky action bars, the compare tray, notices. Every visible
 * `[data-bottom-bar]` that sits at the bottom edge, or on top of another one
 * that does, adds to the stack. Floating UI (the corner assistant, the
 * analytics notice) adds the result to its own `bottom` so it never covers them.
 *
 * `self`: an element that is itself a `[data-bottom-bar]` passes its own ref so
 * it measures only the bars below it (two such elements would otherwise lift
 * over each other forever).
 *
 * Re-measured at most once per frame on DOM changes (added / removed nodes, a
 * class or style change such as a bar moving), resize and scroll (a sticky bar
 * sticks and unsticks as the page scrolls).
 */
export function useBottomBarLift(active: boolean, self?: RefObject<HTMLElement | null>): number {
  const [lift, setLift] = useState(0)

  useEffect(() => {
    if (!active) return
    let raf = 0
    const run = () => {
      raf = 0
      const vh = window.innerHeight
      const own = self?.current ?? null
      const rects = Array.from(document.querySelectorAll<HTMLElement>('[data-bottom-bar]'))
        .filter((el) => !own || !(el === own || own.contains(el) || el.contains(own)))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.height > 0 && r.top < vh)
        .sort((a, b) => b.bottom - a.bottom)
      let top = vh
      for (const r of rects) if (r.bottom >= top - NEAR_PX) top = Math.min(top, r.top)
      setLift(Math.max(0, Math.round(vh - top)))
    }
    // Throttled, not debounced: a stream of DOM changes (streaming, counters)
    // must not keep postponing the measurement.
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(run)
    }
    schedule()
    const mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, { passive: true })
    return () => {
      if (raf) cancelAnimationFrame(raf)
      mo.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule)
    }
  }, [active, self])

  return lift
}
