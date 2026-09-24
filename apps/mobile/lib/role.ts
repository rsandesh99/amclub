import { useEffect, useState } from 'react'
import * as SecureStore from 'expo-secure-store'
import type { MobileRole } from '@amclub/shared'

/**
 * PRD Experience v3 E13 FR-13.1 — which side of the account the tab bar shows
 * (buyer or provider). Remembered on this device only; switched from the
 * profile (avatar) sheet. Subscribers (the tab layout, the orders list)
 * re-render on a switch.
 */
const KEY = 'amc_mobile_role'
let current: MobileRole | null = null
const listeners = new Set<(r: MobileRole) => void>()

export async function loadStoredRole(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY)
  } catch {
    return null
  }
}

export function currentMobileRole(): MobileRole | null {
  return current
}

export function setMobileRole(role: MobileRole): void {
  current = role
  SecureStore.setItemAsync(KEY, role).catch(() => undefined)
  listeners.forEach((l) => l(role))
}

/** The current role (null until the layout has resolved it). */
export function useMobileRole(): MobileRole | null {
  const [role, setRole] = useState<MobileRole | null>(current)
  useEffect(() => {
    const l = (r: MobileRole) => setRole(r)
    listeners.add(l)
    if (current && current !== role) setRole(current)
    return () => { listeners.delete(l) }
  }, [role])
  return role
}
