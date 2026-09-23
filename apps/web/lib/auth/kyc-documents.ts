import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * KYC credential documents (USER_EXPECTATIONS_AUDIT P0-9).
 *
 * provider_verifications.document_url stores the STORAGE PATH inside the
 * private `kyc-documents` bucket — never a signed URL (those expire; the old
 * 7-day URL left the admin queue with dead links). Readers sign on demand
 * with a short TTL (same posture as order documents in lib/orders/queries.ts).
 *
 * Legacy rows hold a full signed URL. Those still work: the path is recovered
 * from the URL and re-signed; a URL that is not one of ours is passed through
 * unchanged.
 */
export const KYC_BUCKET = 'kyc-documents'
export const KYC_SIGNED_URL_TTL_SECONDS = 15 * 60

/** Every credential upload lands under this per-user prefix. */
export function credentialPathPrefix(userId: string): string {
  return `provider-credentials/${userId}/`
}

const SIGNED_URL_PATH = new RegExp(`/storage/v1/object/(?:sign|authenticated|public)/${KYC_BUCKET}/([^?#]+)`)

/** Recover the bucket path from a stored value (a bare path or a legacy signed URL). */
export function kycPathFromStored(stored: string): string | null {
  if (!/^https?:\/\//i.test(stored)) return stored.replace(/^\/+/, '') || null
  try {
    const m = SIGNED_URL_PATH.exec(new URL(stored).pathname)
    return m?.[1] ? decodeURIComponent(m[1]) : null
  } catch {
    return null
  }
}

/**
 * Normalise what the signup wizard sends for a credential upload to the value
 * persisted in document_url: the bucket path, and only when it lies under the
 * caller's own prefix (a provider must not attach someone else's document —
 * the admin view would sign it). Accepts `path`, a path in `url`, or the
 * signed URL older clients / saved drafts carry. Anything else → null.
 */
export function credentialDocumentRef(userId: string, upload: { path?: string | undefined; url?: string | undefined }): string | null {
  const prefix = credentialPathPrefix(userId)
  for (const candidate of [upload.path, upload.url]) {
    if (!candidate) continue
    const p = kycPathFromStored(candidate)
    if (p && p.startsWith(prefix) && !p.includes('..')) return p
  }
  return null
}

/**
 * A short-lived link for an admin to open a stored credential document.
 * Path → fresh signed URL; legacy signed URL → re-signed from its path;
 * a foreign URL → returned unchanged (backward compatible); failure → null.
 */
export async function signKycDocument(admin: Admin, stored: string | null): Promise<string | null> {
  if (!stored) return null
  const p = kycPathFromStored(stored)
  if (!p) return /^https?:\/\//i.test(stored) ? stored : null
  const { data } = await admin.storage.from(KYC_BUCKET).createSignedUrl(p, KYC_SIGNED_URL_TTL_SECONDS)
  return data?.signedUrl ?? null
}
