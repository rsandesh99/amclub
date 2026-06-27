import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { serverError } from '@/lib/api/errors'

/**
 * Lightweight edits to a provider's PUBLIC profile. Deliberately does NOT touch
 * legal_name, GSTIN, PAN, bank details, categories or verification status —
 * those are KYC-controlled (§2.5) and only the full onboarding/admin flow may
 * change them. This route never resets `status`, so editing your bio doesn't
 * send you back to review.
 */
const bodySchema = z.object({
  displayName: z.string().min(2).max(80),
  about: z.string().max(2000).optional(),
  city: z.string().max(80).optional(),
  languages: z.array(z.enum(['en', 'hi'])).min(1),
  capacityPaused: z.boolean(),
})

export async function PATCH(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  const admin = await createAdminClient()
  // Scope the update to the caller's own provider profile.
  const { data: existing } = await admin
    .from('provider_profiles')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle()
  if (!existing) {
    return NextResponse.json({ error: 'No provider profile' }, { status: 404 })
  }

  const { error } = await admin
    .from('provider_profiles')
    .update({
      display_name: d.displayName,
      about: d.about ?? null,
      city: d.city ?? null,
      languages: d.languages,
      capacity_paused: d.capacityPaused,
    })
    .eq('id', existing.id)

  if (error) {
    return serverError('[profile/provider/settings PATCH]', error)
  }

  return NextResponse.json({ success: true })
}
