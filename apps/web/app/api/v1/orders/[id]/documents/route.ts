import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { resolveActor } from '@/lib/orders/actor'

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/zip']
const MAX_BYTES = 15 * 1024 * 1024 // 15 MB
const BUCKET = 'order-documents'

/* eslint-disable @typescript-eslint/no-explicit-any */
async function partyCheck(admin: any, orderId: string, userId: string) {
  const actor = await resolveActor(admin, userId)
  const { data: order } = await admin.from('orders').select('id, msme_id, provider_id').eq('id', orderId).maybeSingle()
  if (!order) return { ok: false as const, status: 404 }
  const isParty =
    (actor.msmeId && order.msme_id === actor.msmeId) || (actor.providerId && order.provider_id === actor.providerId)
  if (!isParty) return { ok: false as const, status: 403 }
  return { ok: true as const, order }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** List order documents with fresh 15-min signed URLs (parties only). §9.4 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const admin = await createAdminClient()
  const check = await partyCheck(admin, id, userId)
  if (!check.ok) return NextResponse.json({ error: 'Forbidden' }, { status: check.status })

  const { data: docs } = await admin
    .from('order_documents')
    .select('id, file_name, mime, size_bytes, kind, file_url, created_at, uploaded_by')
    .eq('order_id', id)
    .order('created_at', { ascending: true })

  const withUrls = await Promise.all(
    (docs ?? []).map(async (d) => {
      const { data: signed } = await admin.storage.from(BUCKET).createSignedUrl(d.file_url, 15 * 60)
      return { ...d, signedUrl: signed?.signedUrl ?? null }
    }),
  )
  return NextResponse.json({ documents: withUrls })
}

/** Upload a document to private storage; record metadata. Parties only. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const admin = await createAdminClient()
  const check = await partyCheck(admin, id, userId)
  if (!check.ok) return NextResponse.json({ error: 'Forbidden' }, { status: check.status })

  const form = await request.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'Invalid form' }, { status: 400 })
  const file = form.get('file') as File | null
  const kind = (form.get('kind') as string | null) ?? 'other'
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })
  if (!ALLOWED.includes(file.type)) return NextResponse.json({ error: 'Unsupported file type' }, { status: 422 })
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'File exceeds 15 MB' }, { status: 422 })

  const ext = file.name.split('.').pop() ?? 'bin'
  const storagePath = `${id}/${kind}-${Date.now()}.${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())
  const { error: upErr } = await admin.storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: file.type,
    upsert: false,
  })
  if (upErr) {
    console.error('[order documents upload]', upErr)
    return NextResponse.json({ error: upErr.message }, { status: 500 })
  }

  const { data: doc, error } = await admin
    .from('order_documents')
    .insert({
      order_id: id,
      uploaded_by: userId,
      file_url: storagePath,
      file_name: file.name,
      mime: file.type,
      size_bytes: file.size,
      kind,
    })
    .select('id')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await admin.from('order_events').insert({
    order_id: id,
    actor_id: userId,
    event: 'document_uploaded',
    payload: { kind, file_name: file.name },
  })

  return NextResponse.json({ id: doc.id })
}
