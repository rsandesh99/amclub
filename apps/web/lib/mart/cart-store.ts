'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * AMC Mart cart — minimal CLIENT state (product ids + quantities + display
 * snapshot for the list). No money lives here: totals come from
 * POST /api/v1/mart/cart/preview and the checkout route (server-computed).
 */
export interface CartLine {
  productId: string
  name: string
  unit: string
  sellerId: string
  sellerName: string
  minOrderQty: number
  qty: number
  imageUrl: string | null
}

interface CartState {
  lines: CartLine[]
  add: (line: Omit<CartLine, 'qty'>, qty: number) => void
  setQty: (productId: string, qty: number) => void
  remove: (productId: string) => void
  clear: () => void
}

export const useCart = create<CartState>()(
  persist(
    (set) => ({
      lines: [],
      add: (line, qty) =>
        set((s) => {
          const existing = s.lines.find((l) => l.productId === line.productId)
          if (existing) {
            return { lines: s.lines.map((l) => (l.productId === line.productId ? { ...l, qty: l.qty + qty } : l)) }
          }
          return { lines: [...s.lines, { ...line, qty }] }
        }),
      setQty: (productId, qty) =>
        set((s) => ({ lines: s.lines.map((l) => (l.productId === productId ? { ...l, qty: Math.max(1, Math.floor(qty)) } : l)) })),
      remove: (productId) => set((s) => ({ lines: s.lines.filter((l) => l.productId !== productId) })),
      clear: () => set({ lines: [] }),
    }),
    { name: 'amc-mart-cart-v1' },
  ),
)

/** Group lines by seller — one order goes to one seller. */
export function groupBySeller(lines: CartLine[]): { sellerId: string; sellerName: string; lines: CartLine[] }[] {
  const out = new Map<string, { sellerId: string; sellerName: string; lines: CartLine[] }>()
  for (const l of lines) {
    const g = out.get(l.sellerId) ?? { sellerId: l.sellerId, sellerName: l.sellerName, lines: [] }
    g.lines.push(l)
    out.set(l.sellerId, g)
  }
  return [...out.values()]
}
