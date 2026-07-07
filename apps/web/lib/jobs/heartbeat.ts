import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * Cron liveness (STATUS_AUDIT B3/#5). Every cron route records a heartbeat on
 * success; /admin flags crons whose last beat is older than their schedule.
 * Best-effort — a heartbeat failure must never fail the job itself.
 */
export async function recordHeartbeat(
  admin: Admin,
  name: string,
  result?: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await admin.from('cron_heartbeats').upsert(
      {
        name,
        last_ok_at: new Date().toISOString(),
        last_result: result ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'name' },
    )
    if (error) console.error('[heartbeat]', name, error.message)
  } catch (e) {
    console.error('[heartbeat]', name, e)
  }
}
