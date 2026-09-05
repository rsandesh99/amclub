import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { martApiGate } from '@/lib/mart/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { getSellerCtx } from '@/lib/mart/seller'
import { publicAssetUrl } from '@/lib/mart/assets'
import { serverError } from '@/lib/api/errors'

const ALLOWED: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const MAX_BYTES = 5 * 1024 * 1024

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
  const ext = ALLOWED[file.type]
  if (!ext) return NextResponse.json({ error: 'Unsupported image type' }, { status: 422 })
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Image exceeds 5 MB' }, { status: 422 })

  const key = `mart/${seller.id}/${randomUUID()}.${ext}`
  const { error } = await admin.storage
    .from('public-assets')
    .upload(key, Buffer.from(await file.arrayBuffer()), { contentType: file.type, upsert: false })
  if (error) return serverError('[mart/seller/images]', error)
  return NextResponse.json({ key, url: publicAssetUrl(key) })
}
