import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { SUPPORTED_LOCALES, employeeBandSchema } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { upsertUserRow } from '@/lib/auth/session'
import { serverError } from '@/lib/api/errors'
import { missingLegalDocs } from '@/lib/legal/acceptance'
import { accountSuspendedResponse, getMsmeSuspension } from '@/lib/auth/suspension'

const bodySchema = z.object({
  fullName: z.string().min(2),
  businessName: z.string().min(2),
  sector: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  // §3.3 — optional at signup; nudged later for full RFQ access.
  udyamNumber: z.string().trim().optional(),
  gstin: z.string().trim().optional(),
  preferredLocale: z.enum(SUPPORTED_LOCALES).default('en'),
  // E0 / U12 — the size band the gateway wizard asked for (was collected, then dropped).
  employeeBand: employeeBandSchema.optional(),
})

export async function POST(request: NextRequest) {
  // Cookie (web) OR Bearer (mobile). Tolerant: works even before the user has a
  // public.users row (new email/Google user completing their first profile).
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { data: { user: authUser } } = await supabase.auth.getUser()

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { fullName, businessName, sector, state, city, udyamNumber, gstin, preferredLocale, employeeBand } = parsed.data

  const admin = await createAdminClient()

  // P0-8 — a suspended buyer can't re-create or edit the suspended profile.
  if (await getMsmeSuspension(admin, userId)) return accountSuspendedResponse()

  // Signup contract (Phase 2): no acceptance at the current Terms + Privacy
  // versions → no profile. Enforced here, not only in the UI.
  const missingLegal = await missingLegalDocs(admin, userId, false)
  if (missingLegal.length > 0) {
    return NextResponse.json({ error: 'legal_acceptance_required', required: missingLegal }, { status: 403 })
  }

  // Create/refresh the users row (preserve existing roles — never clobber).
  const { data: existingUser } = await admin.from('users').select('roles').eq('id', userId).maybeSingle()
  await upsertUserRow({
    id: userId,
    ...(authUser?.phone ? { phone: authUser.phone } : {}),
    ...(authUser?.email ? { email: authUser.email } : {}),
    fullName,
    roles: existingUser?.roles ?? ['msme'],
    preferredLocale,
  })
  const { error } = await admin
    .from('msme_profiles')
    .upsert(
      {
        user_id: userId,
        business_name: businessName,
        sector: sector ?? null,
        state: state ?? null, // honest NULL when skipped — RFQ matching depends on it
        city: city ?? null,
        udyam_number: udyamNumber ?? null,
        gstin: gstin ?? null,
        // Only when sent: a later profile edit without it keeps the stored band.
        ...(employeeBand ? { employee_band: employeeBand } : {}),
        profile_completeness: calculateCompleteness({
          ...(sector ? { sector } : {}),
          ...(state ? { state } : {}),
          ...(city ? { city } : {}),
        }),
      },
      { onConflict: 'user_id' },
    )

  if (error) {
    return serverError('[profile/msme POST]', error)
  }

  return NextResponse.json({ success: true })
}

function calculateCompleteness(fields: { sector?: string; state?: string; city?: string }) {
  let score = 40 // base for having name + business name
  if (fields.sector) score += 20
  if (fields.state) score += 20
  if (fields.city) score += 20
  return score
}
