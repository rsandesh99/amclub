import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isSchemaNotReady } from '@amclub/shared'

/**
 * ADR-030 §6 privacy operations — shared bits. Migrations 0086 (WhatsApp ledger) and 0087 (dpdp_requests) are applied
 * to production AFTER the code that reads them is deployed, so every reader here treats a missing table or column as
 * "not ready": the console shows it, the cron skips with a degraded heartbeat, and the log says so once per instance.
 */

export type Admin = SupabaseClient

/** The private bucket the runtime stores WhatsApp media in (runtime env WA_MEDIA_BUCKET). */
export const WA_MEDIA_BUCKET = process.env['WA_MEDIA_BUCKET'] || 'wa-media'

const logged = new Set<string>()

/** True (and logged once per process) when `error` means the migration behind `what` is not applied yet. */
export function notReady(what: string, error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!isSchemaNotReady(error)) return false
  if (!logged.has(what)) {
    logged.add(what)
    console.warn(`[privacy] ${what}: not migrated yet (${error?.code ?? 'unknown'}) — skipping until the migration is applied`)
  }
  return true
}

/** Thrown inside a job step when its table / column is missing; callers turn it into `notReady: true`. */
export class SchemaNotReadyError extends Error {
  constructor(what: string) {
    super(`not_ready:${what}`)
    this.name = 'SchemaNotReadyError'
  }
}

/** E.164 digits without '+'. */
export const phoneDigits = (p: string | null | undefined): string => String(p ?? '').replace(/\D/g, '')

/** Delete storage objects in chunks; returns how many were removed and whether any chunk failed. */
export async function removeStorageObjects(admin: Admin, bucket: string, paths: readonly string[]): Promise<{ removed: number; failed: boolean }> {
  let removed = 0
  let failed = false
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100)
    if (chunk.length === 0) continue
    const { data, error } = await admin.storage.from(bucket).remove([...chunk])
    if (error) {
      failed = true
      console.error('[privacy] storage remove', bucket, error.message)
    } else removed += (data ?? []).length
  }
  return { removed, failed }
}
