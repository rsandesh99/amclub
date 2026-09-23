import 'server-only'
import { after } from 'next/server'
import { LAST_SEEN_THROTTLE_MS, shouldTouchLastSeen } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'

// Per-instance memo so a busy user costs one DB write per 15 minutes per
// instance; the conditional update makes it one per 15 minutes overall.
const memo = new Map<string, number>()

/**
 * N11 — record authenticated activity (`users.last_seen_at`), throttled to
 * once per 15 minutes per user, after the response is sent. Server-side only
 * (no client beacon). Never throws; activity is a convenience signal.
 */
export function touchLastSeen(userId: string): void {
  const now = Date.now()
  if (!shouldTouchLastSeen(memo.get(userId), now)) return
  memo.set(userId, now)
  if (memo.size > 5000) memo.clear()
  const run = async () => {
    try {
      const admin = await createAdminClient()
      const cutoff = new Date(now - LAST_SEEN_THROTTLE_MS).toISOString()
      await admin.from('users').update({ last_seen_at: new Date(now).toISOString() }).eq('id', userId).or(`last_seen_at.is.null,last_seen_at.lt.${cutoff}`)
    } catch {
      /* activity is best-effort */
    }
  }
  try {
    after(run)
  } catch {
    void run()
  }
}
