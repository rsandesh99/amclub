import { NextResponse } from 'next/server'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'

/**
 * AI spend vs commission (S0.2) — the two business numbers the roadmap manages
 * against: AI cost (sum ai_invocations.cost_est_paise) today and this month, and
 * AI cost as a share of commission (sum invoices.commission_paise) over the same
 * IST windows. Admin/ops only; agentApiGate first.
 *
 * Sums in JS over the window (pilot scale). At volume, replace with a Postgres
 * aggregate RPC (docs/FOLLOWUPS.md — Agent S0.2).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const IST_MS = 5.5 * 3600 * 1000
const CAP = 20_000

function istWindows(now: Date): { dayStart: string; monthStart: string } {
  const ist = new Date(now.getTime() + IST_MS)
  const dayStart = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_MS)
  const monthStart = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_MS)
  return { dayStart: dayStart.toISOString(), monthStart: monthStart.toISOString() }
}

async function sumColumn(
  admin: Awaited<ReturnType<typeof createAdminClient>>,
  table: string,
  column: string,
  since: string,
): Promise<number> {
  const { data } = await admin.from(table).select(column).gte('created_at', since).limit(CAP)
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
  return rows.reduce((acc, r) => acc + Number(r[column] ?? 0), 0)
}

export async function GET() {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const admin = await createAdminClient()
  const { dayStart, monthStart } = istWindows(new Date())

  const [aiToday, aiMonth, commToday, commMonth] = await Promise.all([
    sumColumn(admin, 'ai_invocations', 'cost_est_paise', dayStart),
    sumColumn(admin, 'ai_invocations', 'cost_est_paise', monthStart),
    sumColumn(admin, 'invoices', 'commission_paise', dayStart),
    sumColumn(admin, 'invoices', 'commission_paise', monthStart),
  ])

  const pct = (ai: number, comm: number) => (comm > 0 ? Math.round((ai / comm) * 10000) / 100 : null)

  return NextResponse.json(
    {
      today: { ai_paise: aiToday, commission_paise: commToday, ai_share_pct: pct(aiToday, commToday) },
      month: { ai_paise: aiMonth, commission_paise: commMonth, ai_share_pct: pct(aiMonth, commMonth) },
      window: { day_start: dayStart, month_start: monthStart },
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
