import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser, upsertUserRow } from '@/lib/auth/session'

const bodySchema = z.object({
  fullName: z.string().min(2),
  businessName: z.string().min(2),
  sector: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  preferredLocale: z.enum(['en', 'hi']).default('en'),
})

export async function POST(request: NextRequest) {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { fullName, businessName, sector, state, city, preferredLocale } = parsed.data

  // Update full_name + locale on the users row
  await upsertUserRow({
    id: user.id,
    ...(user.phone ? { phone: user.phone } : {}),
    ...(user.email ? { email: user.email } : {}),
    fullName,
    roles: user.roles,
    preferredLocale,
  })

  // Upsert msme_profiles
  const admin = await createAdminClient()
  const { error } = await admin
    .from('msme_profiles')
    .upsert(
      {
        user_id: user.id,
        business_name: businessName,
        sector: sector ?? null,
        state: state ?? 'XX',
        city: city ?? null,
        profile_completeness: calculateCompleteness({
          ...(sector ? { sector } : {}),
          ...(state ? { state } : {}),
          ...(city ? { city } : {}),
        }),
      },
      { onConflict: 'user_id' },
    )

  if (error) {
    console.error('[profile/msme POST]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

function calculateCompleteness(fields: { sector?: string; state?: string; city?: string }) {
  let score = 40 // base for having name + business name
  if (fields.sector) score += 20
  if (fields.state && fields.state !== 'XX') score += 20
  if (fields.city) score += 20
  return score
}
