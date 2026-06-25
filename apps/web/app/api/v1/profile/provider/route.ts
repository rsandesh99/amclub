import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser, upsertUserRow } from '@/lib/auth/session'
import { encryptColumn } from '@/lib/crypto'

const credentialUploadSchema = z.object({
  url: z.string().optional(),
  path: z.string().optional(),
  name: z.string().optional(),
})

const bodySchema = z.object({
  fullName: z.string().min(2).optional(),
  preferredLocale: z.enum(['en', 'hi']).default('en'),
  legalName: z.string().min(2),
  displayName: z.string().min(2),
  about: z.string().max(2000).optional(),
  gstin: z.string().optional(),
  pan: z.string().optional(),
  categorySlugs: z.array(z.string()).min(1).max(5),
  state: z.string().min(2),
  city: z.string().optional(),
  languages: z.array(z.string()).default(['en']),
  bankIfsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/),
  bankAccount: z.string().min(9).max(18),
  bankHolder: z.string().min(2),
  bankVerified: z.boolean().default(false),
  // Keyed by category slug → { url|path, name }
  credentialUploads: z.record(z.string(), credentialUploadSchema).default({}),
})

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

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

  // 1. Ensure the user row carries the provider role
  const newRoles = Array.from(new Set([...(user.roles ?? ['msme']), 'provider']))
  await upsertUserRow({
    id: user.id,
    ...(user.phone ? { phone: user.phone } : {}),
    ...(user.email ? { email: user.email } : {}),
    ...(d.fullName ? { fullName: d.fullName } : {}),
    roles: newRoles,
    preferredLocale: d.preferredLocale,
  })

  // 2. Resolve category slugs → ids (validates they exist)
  const { data: cats, error: catLookupErr } = await admin
    .from('categories')
    .select('id, slug')
    .in('slug', d.categorySlugs)
  if (catLookupErr) {
    console.error('[profile/provider POST] category lookup:', catLookupErr)
    return NextResponse.json({ error: catLookupErr.message }, { status: 500 })
  }
  if (!cats || cats.length === 0) {
    return NextResponse.json({ error: 'No valid categories selected' }, { status: 422 })
  }
  const slugToId = new Map(cats.map((c) => [c.slug, c.id]))

  // 3. Upsert provider_profiles. Generate a unique slug on first create.
  const { data: existing } = await admin
    .from('provider_profiles')
    .select('id, slug')
    .eq('user_id', user.id)
    .maybeSingle()

  const slug = existing?.slug ?? `${slugify(d.displayName)}-${randomSuffix()}`

  const { data: profile, error: profileErr } = await admin
    .from('provider_profiles')
    .upsert(
      {
        user_id: user.id,
        legal_name: d.legalName,
        display_name: d.displayName,
        slug,
        about: d.about ?? null,
        gstin: d.gstin ?? null,
        pan: d.pan ?? null,
        state: d.state,
        city: d.city ?? null,
        languages: d.languages,
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
  const providerId = profile.id

  // 4. Category links (replace existing set)
  await admin.from('provider_categories').delete().eq('provider_id', providerId)
  const catRows = Array.from(slugToId.values()).map((category_id) => ({
    provider_id: providerId,
    category_id,
  }))
  if (catRows.length > 0) {
    const { error: catErr } = await admin.from('provider_categories').insert(catRows)
    if (catErr) console.error('[profile/provider POST] categories:', catErr)
  }

  // 5. Verification records (replace existing set). One row per concrete item.
  await admin.from('provider_verifications').delete().eq('provider_id', providerId)
  const verifications: {
    provider_id: string
    kind: string
    value: string
    document_url: string | null
    status: string
  }[] = []
  if (d.gstin) {
    verifications.push({ provider_id: providerId, kind: 'gstin', value: d.gstin, document_url: null, status: 'pending' })
  }
  if (d.pan) {
    verifications.push({ provider_id: providerId, kind: 'pan', value: d.pan, document_url: null, status: 'pending' })
  }
  for (const [categorySlug, upload] of Object.entries(d.credentialUploads)) {
    verifications.push({
      provider_id: providerId,
      kind: 'credential',
      value: categorySlug,
      document_url: upload.url ?? upload.path ?? null,
      status: 'pending',
    })
  }
  if (verifications.length > 0) {
    const { error: verErr } = await admin.from('provider_verifications').insert(verifications)
    if (verErr) console.error('[profile/provider POST] verifications:', verErr)
  }

  // 6. Bank account (encrypted account number). Upsert by provider_id.
  const { error: bankErr } = await admin.from('provider_bank_accounts').upsert(
    {
      provider_id: providerId,
      account_number_enc: encryptColumn(d.bankAccount),
      ifsc: d.bankIfsc,
      account_holder: d.bankHolder,
      penny_drop_verified: d.bankVerified,
    },
    { onConflict: 'provider_id' },
  )
  if (bankErr) {
    console.error('[profile/provider POST] bank account:', bankErr)
    return NextResponse.json({ error: bankErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, providerId, slug, status: 'under_review' })
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}
