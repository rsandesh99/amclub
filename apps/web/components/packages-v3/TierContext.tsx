'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  /** E12a / ADR 019 — this option's active add-ons (server-localized; empty while the switch is off). */
  addons?: BuyAddon[]
}

/** One add-on as the buy box shows it. The price is the server's; the client never adds it up. */
export interface BuyAddon {
  id: string
  label: string
  pricePaise: number
  daysDelta: number
  extraRevisions: number
}

/** The server preview for the selected option + chosen add-ons (POST /api/v1/checkout/preview). */
export interface AddonQuote {
  display: PriceDisplay
  deliveryDays: number
  revisionMax: number | null
}

interface TierState {
  options: BuyOption[]
  selected: BuyOption
  select: (packageId: string) => void
  mostChosen: PackageTier | null
  /** E12a — the chosen add-on ids for the selected option, the server quote for them, and its state. */
  chosen: string[]
  toggleAddon: (id: string) => void
  quote: AddonQuote | null
  quoteBusy: boolean
  addonNote: 'changed' | 'failed' | null
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
  const [chosen, setChosen] = useState<string[]>([])
  const [quote, setQuote] = useState<AddonQuote | null>(null)
  const [quoteBusy, setQuoteBusy] = useState(false)
  const [addonNote, setAddonNote] = useState<'changed' | 'failed' | null>(null)
  const seq = useRef(0)

  // Every total with add-ons is the server's (the same packageCharge checkout freezes).
  const requote = useCallback(
    async (packageId: string, ids: string[]) => {
      const n = ++seq.current
      if (ids.length === 0) {
        setQuote(null)
        setQuoteBusy(false)
        return
      }
      setQuoteBusy(true)
      try {
        const res = await fetch('/api/v1/checkout/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageId, addonIds: ids }) })
        if (n !== seq.current) return
        if (res.status === 409) {
          setChosen([])
          setQuote(null)
          setAddonNote('changed')
        } else if (!res.ok) {
          setChosen([])
          setQuote(null)
          setAddonNote('failed')
        } else {
          setQuote((await res.json()) as AddonQuote)
        }
      } catch {
        if (n === seq.current) {
          setChosen([])
          setQuote(null)
          setAddonNote('failed')
        }
      } finally {
        if (n === seq.current) setQuoteBusy(false)
      }
    },
    [],
  )

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
        // Add-ons belong to one package: a new tier starts with none.
        setChosen([])
        setAddonNote(null)
        void requote(id, [])
        analytics.capture('tier_selected', { device: 'web', tier: next.tier })
      },
      chosen,
      quote,
      quoteBusy,
      addonNote,
      toggleAddon: (addonId) => {
        const on = !chosen.includes(addonId)
        const next = on ? [...chosen, addonId] : chosen.filter((x) => x !== addonId)
        setChosen(next)
        setAddonNote(null)
        analytics.capture('addon_toggled', { device: 'web', on })
        void requote(selected.packageId, next)
      },
    }),
    [options, selected, mostChosen, selectedId, analytics, chosen, quote, quoteBusy, addonNote, requote],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
