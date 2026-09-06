/**
 * AMC Mart cart — minimal Zustand client state (CLAUDE.md stack). Lines hold
 * product ids + quantities plus the display snapshot needed to render a line
 * (name, unit, seller, server LIST unit price). No money is derived here: the
 * server prices the cart at checkout (POST /api/v1/mart/checkout) and the UI
 * renders those amounts verbatim.
 *
 * Persisted via expo-secure-store (already a dependency; AsyncStorage is not)
 * in a compact form — SecureStore values are capped at ~2 KB on some
 * platforms, so a save that overflows is swallowed and the cart simply lives
 * in memory for that session.
 */
import { create } from 'zustand'
import * as SecureStore from 'expo-secure-store'

const CART_KEY = 'amc_mart_cart'

export interface MartCartLine {
  productId: string
  name: string
  unit: string
  minOrderQty: number
  qty: number
  sellerId: string
  sellerName: string
  /** Server list-tier unit price (paise) captured when added; display only. */
  listUnitPricePaise: number | null
}

interface MartCartState {
  lines: MartCartLine[]
  hydrated: boolean
  add: (line: Omit<MartCartLine, 'qty'>, qty: number) => void
  setQty: (productId: string, qty: number) => void
  remove: (productId: string) => void
  removeMany: (productIds: string[]) => void
  clear: () => void
}

type Stored = { p: string; n: string; u: string; m: number; q: number; s: string; sn: string; lp: number | null }

function toStored(l: MartCartLine): Stored {
  return { p: l.productId, n: l.name, u: l.unit, m: l.minOrderQty, q: l.qty, s: l.sellerId, sn: l.sellerName, lp: l.listUnitPricePaise }
}

function fromStored(s: Stored): MartCartLine {
  return {
    productId: s.p,
    name: s.n,
    unit: s.u,
    minOrderQty: Number(s.m) || 1,
    qty: Number(s.q) || 1,
    sellerId: s.s,
    sellerName: s.sn,
    listUnitPricePaise: typeof s.lp === 'number' ? s.lp : null,
  }
}

function persist(lines: MartCartLine[]) {
  try {
    const payload = JSON.stringify(lines.map(toStored))
    SecureStore.setItemAsync(CART_KEY, payload).catch(() => {})
  } catch {
    // Storage unavailable — in-memory cart only.
  }
}

export const useMartCart = create<MartCartState>((set, get) => ({
  lines: [],
  hydrated: false,
  add: (line, qty) => {
    const q = Math.max(qty, line.minOrderQty, 1)
    const existing = get().lines.find((l) => l.productId === line.productId)
    const lines = existing
      ? get().lines.map((l) => (l.productId === line.productId ? { ...l, ...line, qty: l.qty + q } : l))
      : [...get().lines, { ...line, qty: q }]
    set({ lines })
    persist(lines)
  },
  setQty: (productId, qty) => {
    const lines = get().lines.map((l) => (l.productId === productId ? { ...l, qty: Math.max(1, Math.round(qty)) } : l))
    set({ lines })
    persist(lines)
  },
  remove: (productId) => {
    const lines = get().lines.filter((l) => l.productId !== productId)
    set({ lines })
    persist(lines)
  },
  removeMany: (productIds) => {
    const drop = new Set(productIds)
    const lines = get().lines.filter((l) => !drop.has(l.productId))
    set({ lines })
    persist(lines)
  },
  clear: () => {
    set({ lines: [] })
    persist([])
  },
}))

/** Restore the persisted cart once per app launch (idempotent). */
export async function hydrateMartCart(): Promise<void> {
  if (useMartCart.getState().hydrated) return
  try {
    const raw = await SecureStore.getItemAsync(CART_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    const lines = Array.isArray(parsed)
      ? (parsed as Stored[]).filter((s) => s && typeof s.p === 'string').map(fromStored)
      : []
    // Keep anything added while the read was in flight.
    const inFlight = useMartCart.getState().lines
    const merged = [...lines.filter((l) => !inFlight.some((i) => i.productId === l.productId)), ...inFlight]
    useMartCart.setState({ lines: merged, hydrated: true })
  } catch {
    useMartCart.setState({ hydrated: true })
  }
}

/** Group lines by seller — one seller per checkout (MART_DESIGN §4.3). */
export function groupBySeller(lines: MartCartLine[]): { sellerId: string; sellerName: string; lines: MartCartLine[] }[] {
  const out: { sellerId: string; sellerName: string; lines: MartCartLine[] }[] = []
  for (const l of lines) {
    const g = out.find((x) => x.sellerId === l.sellerId)
    if (g) g.lines.push(l)
    else out.push({ sellerId: l.sellerId, sellerName: l.sellerName, lines: [l] })
  }
  return out
}
