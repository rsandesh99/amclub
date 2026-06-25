import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser, upsertUserRow } from '@/lib/auth/session'

const bodySchema = z.object({
  // Step: contact
  fullName: z.string().min(2),
  preferredLocale: z.enum(['en', 'hi']).default('en'),
  // Step: business
  businessName: z.string().min(2),
  gstin: z.string().optional(),
  state: z.string(),
  city: z.string().optional(),
  categoryIds: z.array(z.string().uuid()).min(1).max(5),
  // Step: KYC
  gstinVerified: z.boolean().default(false),
  credentialPaths: z.array(z.string()).default([]),
  // Step: bank
  bankAccountNumber: z.string().min(9).max(18),
  bankIfsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/),
  bankHolderName: z.string().min(2),
  bankVerified: z.boolean().default(false),
  // Step: bio/pricing
  bio: z.string().max(1000).optional(),
  experienceYears: z.number().int().min(0).max(50).optional(),
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

  const d = parsed.data
  const admin = await createAdminClient()

  // 1. Ensure user has provider role
  const newRoles = Array.from(new Set([...(user.roles ?? ['msme']), 'provider']))
  await upsertUserRow({
    id: user.id,
    ...(user.phone ? { phone: user.phone } : {}),
    ...(user.email ? { email: user.email } : {}),
    fullName: d.fullName,
    roles: newRoles,
    preferredLocale: d.preferredLocale,
  })

  // 2. Upsert provider_profiles
  const { data: profile, error: profileErr } = await admin
    .from('provider_profiles')
    .upsert(
      {
        user_id: user.id,
        business_name: d.businessName,
        gstin: d.gstin ?? null,
        state: d.state,
        city: d.city ?? null,
        bio: d.bio ?? null,
        experience_years: d.experienceYears ?? null,
        bank_account_number: d.bankAccountNumber,
        bank_ifsc: d.bankIfsc,
        bank_holder_name: d.bankHolderName,
        bank_verified: d.bankVerified,
        credential_paths: d.credentialPaths,
        status: 'under_review',
      },
      { onConflict: 'user_id' },
    )
    .select('id')
    .single()

  if (profileErr || !profile) {
    console.error('[profile/provider POST] upsert profile:', profileErr)
    return NextResponse.json({ error: profileErr?.message ?? 'DB error' }, { status: 500 })
  }

  // 3. Link categories via provider_categories join table
  // Delete old category links, insert new ones
  await admin.from('provider_categories').delete().eq('provider_id', profile.id)
  if (d.categoryIds.length > 0) {
    const rows = d.categoryIds.map((catId) => ({
      provider_id: profile.id,
      category_id: catId,
    }))
    const { error: catErr } = await admin.from('provider_categories').insert(rows)
    if (catErr) {
      console.error('[profile/provider POST] categories:', catErr)
      // Non-fatal — profile created, categories partially linked
    }
  }

  // 4. Insert verification record
  const { error: verErr } = await admin.from('provider_verifications').upsert(
    {
      provider_id: profile.id,
      gstin_verified: d.gstinVerified,
      bank_verified: d.bankVerified,
      credential_paths: d.credentialPaths,
      status: 'pending',
    },
    { onConflict: 'provider_id' },
  )
  if (verErr) {
    console.error('[profile/provider POST] verification:', verErr)
  }

  return NextResponse.json({ success: true, providerId: profile.id, status: 'under_review' })
}
