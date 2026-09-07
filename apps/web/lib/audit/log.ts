import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
import { createHash } from 'crypto'
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
 * audit_logs.entity_id is a uuid. For tables keyed by text (mart_settings.key,
 * mart_categories.slug) derive a STABLE uuid-shaped id from the key so the row
 * is filterable, and put the human key in before/after as well.
 */
export function stableEntityId(entity: string, key: string): string {
  const h = createHash('sha1').update(`${entity}:${key}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
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
