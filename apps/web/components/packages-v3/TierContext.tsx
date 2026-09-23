'use client'

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CompareValue, PackageTier, PriceDisplay } from '@amclub/shared'
import { useAnalytics } from '@/components/providers/posthog'

/**
 * Experience v3 E4 — one purchasable option on the package page: the page's
 * own package, or one tier of its group. Localized and priced on the server
 * (`display`); the client only chooses between options, it never computes.
 */
export interface BuyOption {
  packageId: string
  slug: string
  tier: PackageTier | null
  title: string
  idealFor: string | null
  /** E14 — the English when `idealFor` is an approved machine translation (shows "Translated · View original"). */
  idealForOriginal?: string | null
  compareValues: Record<string, CompareValue>
  deliveryDays: number
  revisionCount: number
  display: PriceDisplay
  govtDependent: boolean
}

interface TierState {
  options: BuyOption[]
  selected: BuyOption
  select: (packageId: string) => void
  mostChosen: PackageTier | null
}

const Ctx = createContext<TierState | null>(null)

export function useTierState(): TierState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTierState outside TierProvider')
  return v
}

export function TierProvider({
  options,
  initialPackageId,
  mostChosen,
  children,
}: {
  options: BuyOption[]
  initialPackageId: string
  mostChosen: PackageTier | null
  children: ReactNode
}) {
  const analytics = useAnalytics()
  const [selectedId, setSelectedId] = useState(initialPackageId)
  const selected = options.find((o) => o.packageId === selectedId) ?? options[0]!
  const viewed = useRef(false)

  useEffect(() => {
    if (viewed.current) return
    viewed.current = true
    analytics.capture('package_viewed', { device: 'web', tiers: options.length })
  }, [analytics, options.length])

  const value = useMemo<TierState>(
    () => ({
      options,
      selected,
      mostChosen,
      select: (id) => {
        if (id === selectedId) return
        const next = options.find((o) => o.packageId === id)
        if (!next) return
        setSelectedId(id)
        analytics.capture('tier_selected', { device: 'web', tier: next.tier })
      },
    }),
    [options, selected, mostChosen, selectedId, analytics],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
