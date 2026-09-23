import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import sharp from 'sharp'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_IN = 2 * 1024 * 1024
/** 1:1, enough for a 96 px avatar at 4× — ~15–40 KB as WebP (≤ 200 KB stored). */
const EDGE = 384

/**
 * POST /api/v1/profile/provider/logo (E3 / N12) — the caller's OWN logo.
 * Cropped square, resized and stored in a PRIVATE bucket as a pending upload;
 * it shows publicly only after an admin approves it (moderation), which copies
 * it to the public bucket and sets logo_url.
 */
export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('profile/provider/logo')
  if (delegated) return delegated
  const rl = await enforce(limiters.kyc, `logo:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const admin = await createAdminClient()
  const { data: p } = await admin.from('provider_profiles').select('id').eq('user_id', userId).maybeSingle()
  if (!p) return NextResponse.json({ error: 'No provider profile' }, { status: 404 })

  const form = await request.formData().catch(() => null)
  const file = form?.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })
  if (!ALLOWED.has(file.type)) return NextResponse.json({ error: 'unsupported_type' }, { status: 422 })
  if (file.size > MAX_IN) return NextResponse.json({ error: 'too_large' }, { status: 422 })

  let body: Buffer
  try {
    body = await sharp(Buffer.from(await file.arrayBuffer())).rotate().resize({ width: EDGE, height: EDGE, fit: 'cover' }).webp({ quality: 82 }).toBuffer()
  } catch {
    return NextResponse.json({ error: 'unreadable_image' }, { status: 422 })
  }
  const key = `logos/${p.id}/${randomUUID()}.webp`
  const { error: upErr } = await admin.storage.from('kyc-documents').upload(key, body, { contentType: 'image/webp', upsert: false })
  if (upErr) return serverError('[provider/logo upload]', upErr)
  const { error } = await admin.from('provider_profiles').update({ logo_pending_url: key, logo_status: 'pending' }).eq('id', p.id)
  if (error) return serverError('[provider/logo PATCH]', error)
  return NextResponse.json({ status: 'pending' })
}
