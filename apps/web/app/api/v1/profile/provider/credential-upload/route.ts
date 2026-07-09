import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { serverError } from '@/lib/api/errors'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
const MAX_BYTES = 5 * 1024 * 1024 // 5 MB

// The extension comes from the SNIFFED type, never the client filename.
const TYPE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

/** Magic-byte check (Phase 8 §8 — OWASP file-upload): the declared MIME is
 *  client-controlled; verify the actual content signature matches it. */
function sniffMatches(declared: string, buf: Buffer): boolean {
  if (buf.length < 12) return false
  switch (declared) {
    case 'image/jpeg':
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
    case 'image/png':
      return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    case 'image/webp':
      return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'
    case 'application/pdf':
      return buf.toString('ascii', 0, 5) === '%PDF-'
    default:
      return false
  }
}

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

  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  if (!sniffMatches(file.type, buffer)) {
    return NextResponse.json(
      { error: 'File content does not match its type' },
      { status: 422 },
    )
  }

  // docType lands in the storage path — clamp it, and derive the extension
  // from the verified type (client filename never touches the path).
  const safeDocType = docType.replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'credential'
  const path = `provider-credentials/${user.id}/${safeDocType}-${Date.now()}.${TYPE_EXT[file.type]}`

  const admin = await createAdminClient()
  const { error } = await admin.storage
    .from('kyc-documents')
    .upload(path, buffer, {
      contentType: file.type,
      upsert: false,
    })

  if (error) {
    return serverError('[credential-upload]', error)
  }

  // Return a signed URL valid for 7 days so the admin can view it
  const { data: signedData } = await admin.storage
    .from('kyc-documents')
    .createSignedUrl(path, 60 * 60 * 24 * 7)

  return NextResponse.json({
    path,
    // `url` is what the wizard stores in credentialUploads[slug].url
    url: signedData?.signedUrl ?? null,
    signedUrl: signedData?.signedUrl ?? null,
  })
}
