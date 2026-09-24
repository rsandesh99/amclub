/**
 * S3.4 (ADR 024) — view shapes shared by the pool pages and their client components (no server-only imports, so a
 * 'use client' file can import the types). The server builds them in lib/pools/queries.ts.
 */
import type { PoolMemberStatus, PoolTierView, ServicePoolStatus } from '@amclub/shared'

export interface PoolRfqCard {
  poolId: string
  status: ServicePoolStatus
  memberStatus: PoolMemberStatus
  joinedCount: number
  minMembers: number
  formBy: string
  closesAt: string | null
  quoteId: string | null
}

export interface PoolProviderView {
  id: string
  status: ServicePoolStatus
  serviceSlug: string
  categoryName: string
  state: string
  joinedCount: number
  maxMembers: number
  closesAt: string | null
  /** The joined members' requests this provider is matched to (they can read each one as usual). */
  matchedRfqIds: string[]
  mine: {
    id: string
    status: string
    deliveryDays: number
    scope: string
    gstIncluded: boolean
    validUntil: string
    tiers: PoolTierView[]
    achievedCount: number | null
    achievedPricePaise: number | null
  } | null
}
