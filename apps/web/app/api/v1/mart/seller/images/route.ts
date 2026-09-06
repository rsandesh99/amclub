import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { martApiGate } from '@/lib/mart/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { getSellerCtx } from '@/lib/mart/seller'
import { publicAssetUrl } from '@/lib/mart/assets'
import { serverError } from '@/lib/api/errors'
import sharp from 'sharp'

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_BYTES = 8 * 1024 * 1024
/** Longest edge after resize — enough for a 2× product hero, ~40–80 KB as WebP. */
const MAX_EDGE = 1200

/** Upload one product photo to the PUBLIC assets bucket under the seller's prefix. */
export async function POST(request: NextRequest) {
  const gate = martApiGate()
  if (gate) return gate
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = await createAdminClient()
  const seller = await getSellerCtx(admin, userId)
  if (!seller) return NextResponse.json({ error: 'No provider profile' }, { status: 404 })

  const form = await request.formData().catch(() => null)
  const file = form?.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })
  if (!ALLOWED.has(file.type)) return NextResponse.json({ error: 'Unsupported image type' }, { status: 422 })
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Image exceeds 8 MB' }, { status: 422 })

  // Phone photos arrive at 3–6 MB; the catalogue never needs more than 1200px.
  // Resize + WebP here so every later render (cards, product hero, admin
  // queue) pays for ~60 KB instead of the raw capture. EXIF orientation is
  // honoured (rotate()) so shop-floor portrait shots stay upright.
  let body: Buffer
  try {
    body = await sharp(Buffer.from(await file.arrayBuffer()))
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer()
  } catch (e) {
    return serverError('[mart/seller/images resize]', e)
  }
  const key = `mart/${seller.id}/${randomUUID()}.webp`
  const { error } = await admin.storage
    .from('public-assets')
    // Immutable key → a year of browser/CDN caching.
    .upload(key, body, { contentType: 'image/webp', upsert: false, cacheControl: '31536000' })
  if (error) return serverError('[mart/seller/images]', error)
  return NextResponse.json({ key, url: publicAssetUrl(key) })
}
