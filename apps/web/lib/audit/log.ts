import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
import { clientIp } from '@/lib/rate-limit'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export interface AuditEntry {
  actorId: string | null
  action: string
  entity: string
  entityId: string
  before?: unknown
  after?: unknown
}

/**
 * Append an audit_logs row (§7 — every admin mutation is audit-logged). The IP
 * is best-effort from the request proxy headers. Never throws — auditing must
 * never block the action it records (the action itself is the source of truth).
 */
export async function writeAudit(admin: Admin, request: Request | null, entry: AuditEntry): Promise<void> {
  try {
    await admin.from('audit_logs').insert({
      actor_id: entry.actorId,
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entityId,
      before: entry.before ?? null,
      after: entry.after ?? null,
      ip: request ? clientIp(request) : null,
    })
  } catch (e) {
    console.error('[writeAudit]', entry.action, e)
  }
}
