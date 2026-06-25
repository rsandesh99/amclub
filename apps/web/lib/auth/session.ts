import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/server'

export interface SessionUser {
  id: string
  phone: string | null
  email: string | null
  fullName: string | null
  roles: string[]
  preferredLocale: string
}

export interface MsmeProfile {
  id: string
  businessName: string
  sector: string | null
  state: string
  city: string | null
  profileCompleteness: number
  udyamVerified: boolean
  gstinVerified: boolean
}

export interface ProviderProfile {
  id: string
  legalName: string
  displayName: string
  slug: string
  status: string
  avgRating: string
  completedOrders: number
}

/**
 * Returns the authenticated user row from public.users (not auth.users).
 * Returns null if the user is not authenticated or has no profile row yet.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data } = await supabase
    .from('users')
    .select('id, phone, email, full_name, roles, preferred_locale')
    .eq('id', user.id)
    .single()

  if (!data) return null

  return {
    id: data.id,
    phone: data.phone,
    email: data.email,
    fullName: data.full_name,
    roles: data.roles ?? ['msme'],
    preferredLocale: data.preferred_locale ?? 'en',
  }
}

export async function getMsmeProfile(userId: string): Promise<MsmeProfile | null> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('msme_profiles')
    .select('id, business_name, sector, state, city, profile_completeness, udyam_verified, gstin_verified')
    .eq('user_id', userId)
    .single()

  if (!data) return null

  return {
    id: data.id,
    businessName: data.business_name,
    sector: data.sector,
    state: data.state,
    city: data.city,
    profileCompleteness: data.profile_completeness ?? 0,
    udyamVerified: data.udyam_verified ?? false,
    gstinVerified: data.gstin_verified ?? false,
  }
}

export async function getProviderProfile(userId: string): Promise<ProviderProfile | null> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('provider_profiles')
    .select('id, legal_name, display_name, slug, status, avg_rating, completed_orders')
    .eq('user_id', userId)
    .single()

  if (!data) return null

  return {
    id: data.id,
    legalName: data.legal_name,
    displayName: data.display_name,
    slug: data.slug,
    status: data.status,
    avgRating: data.avg_rating ?? '0.0',
    completedOrders: data.completed_orders ?? 0,
  }
}

/**
 * Upsert a row in public.users after successful auth (used in OTP verify + OAuth callback).
 * Uses admin client so it works even if the user doesn't have a row yet.
 */
export async function upsertUserRow(params: {
  id: string
  phone?: string
  email?: string
  fullName?: string
  roles?: string[]
  preferredLocale?: string
}) {
  const adminClient = await createAdminClient()
  const { error } = await adminClient
    .from('users')
    .upsert(
      {
        id: params.id,
        phone: params.phone ?? null,
        email: params.email ?? null,
        full_name: params.fullName ?? null,
        roles: params.roles ?? ['msme'],
        preferred_locale: params.preferredLocale ?? 'en',
      },
      { onConflict: 'id', ignoreDuplicates: false },
    )
  return { error }
}
