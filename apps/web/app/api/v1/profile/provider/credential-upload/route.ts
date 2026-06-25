import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
const MAX_BYTES = 5 * 1024 * 1024 // 5 MB

export async function POST(request: NextRequest) {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const formData = await request.formData().catch(() => null)
  if (!formData) {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const file = formData.get('file') as File | null
  const docType = (formData.get('docType') as string | null) ?? 'credential'

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: 'File must be JPEG, PNG, WebP, or PDF' },
      { status: 422 },
    )
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File exceeds 5 MB limit' }, { status: 422 })
  }

  const ext = file.name.split('.').pop() ?? 'bin'
  const path = `provider-credentials/${user.id}/${docType}-${Date.now()}.${ext}`

  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  const admin = await createAdminClient()
  const { error } = await admin.storage
    .from('kyc-documents')
    .upload(path, buffer, {
      contentType: file.type,
      upsert: false,
    })

  if (error) {
    console.error('[credential-upload]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Return a signed URL valid for 7 days so the admin can view it
  const { data: signedData } = await admin.storage
    .from('kyc-documents')
    .createSignedUrl(path, 60 * 60 * 24 * 7)

  return NextResponse.json({
    path,
    signedUrl: signedData?.signedUrl ?? null,
  })
}
