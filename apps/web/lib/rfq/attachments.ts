import 'server-only'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { RFQ_ATTACHMENTS_BUCKET, RFQ_ATTACHMENT_MAX_BYTES, classifyIntakeFile, type IntakeFileKind, type RfqAttachmentExt } from '@amclub/shared'

/**
 * S1.8 — RFQ attachments (SPINE). One private bucket, one upload helper shared
 * by POST /api/v1/rfq/attachments and POST /api/v1/rfq/document-extract (the
 * document route stores the file as an attachment in the same call so the
 * client never uploads twice). `attachments[].url` on the RFQ row is the
 * bucket-relative reference `rfq-attachments/<msmeId>/<uuid>.<ext>`; the two
 * detail loaders resolve it to a 15-minute signed URL for the buyer and the
 * matched providers (nobody else reaches those loaders). Legacy http(s) URLs
 * pass through untouched.
 */

export const RFQ_ATTACHMENT_PREFIX = `${RFQ_ATTACHMENTS_BUCKET}/`
const SIGNED_TTL_S = 15 * 60

export interface StoredRfqAttachment {
  /** `rfq-attachments/<path>` — what goes into rfqs.attachments[].url. */
  url: string
  name: string
  path: string
  mime: string
  size: number
  kind: IntakeFileKind
  ext: RfqAttachmentExt
  bytes: Buffer
}

export type StoreRfqAttachmentError = 'file_required' | 'file_too_large' | 'file_type_unsupported' | 'upload_failed'

const CONTENT_TYPE: Record<IntakeFileKind, (mime: string, ext: string) => string> = {
  image: (mime, ext) => (mime.startsWith('image/') ? mime : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'),
  pdf: () => 'application/pdf',
  step: () => 'application/step',
  dxf: () => 'application/dxf',
}

/** Client-supplied names are display-only: strip path separators, cap the length. */
export function safeAttachmentName(name: string): string {
  const base = (name || 'attachment').split(/[\\/]/).pop() ?? 'attachment'
  return base.replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'attachment'
}

export async function storeRfqAttachment(
  admin: SupabaseClient,
  msmeId: string,
  file: File | null,
): Promise<{ ok: true; attachment: StoredRfqAttachment } | { ok: false; error: StoreRfqAttachmentError; detail?: string }> {
  if (!file || file.size === 0) return { ok: false, error: 'file_required' }
  if (file.size > RFQ_ATTACHMENT_MAX_BYTES) return { ok: false, error: 'file_too_large' }
  const cls = classifyIntakeFile(file.name ?? '', file.type ?? '')
  if (!cls) return { ok: false, error: 'file_type_unsupported' }
  const bytes = Buffer.from(await file.arrayBuffer())
  const path = `${msmeId}/${randomUUID()}.${cls.ext}`
  const mime = CONTENT_TYPE[cls.kind](file.type ?? '', cls.ext)
  const { error } = await admin.storage.from(RFQ_ATTACHMENTS_BUCKET).upload(path, bytes, { contentType: mime, upsert: false })
  if (error) return { ok: false, error: 'upload_failed', detail: error.message }
  return { ok: true, attachment: { url: `${RFQ_ATTACHMENT_PREFIX}${path}`, name: safeAttachmentName(file.name), path, mime, size: file.size, kind: cls.kind, ext: cls.ext, bytes } }
}

/** Remove a stored attachment (verify rigs + the document route's own failure path). */
export async function removeRfqAttachment(admin: SupabaseClient, path: string): Promise<void> {
  await admin.storage.from(RFQ_ATTACHMENTS_BUCKET).remove([path])
}

export interface SignedRfqAttachment {
  url: string
  name: string
  /** True when the url was a bucket reference resolved to a signed URL. */
  stored: boolean
}

/** Resolve bucket references to 15-minute signed URLs; anything else passes through. */
export async function signRfqAttachments(admin: SupabaseClient, attachments: ReadonlyArray<{ url: string; name: string }>): Promise<SignedRfqAttachment[]> {
  return Promise.all(
    attachments.map(async (a) => {
      if (!a.url.startsWith(RFQ_ATTACHMENT_PREFIX)) return { url: a.url, name: a.name, stored: false }
      const path = a.url.slice(RFQ_ATTACHMENT_PREFIX.length)
      const { data } = await admin.storage.from(RFQ_ATTACHMENTS_BUCKET).createSignedUrl(path, SIGNED_TTL_S)
      return { url: data?.signedUrl ?? '', name: a.name, stored: true }
    }),
  )
}
