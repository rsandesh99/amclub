import type { SupabaseClient } from '@supabase/supabase-js'
import { bindTextConfirmation, DEFAULT_TEXT_WINDOWS, quotedVendorMessageId, type OpenConfirmable, type TextBinding } from '@amclub/agent-core'
import { isUnambiguousYes, procurementSessionIsActive } from '@amclub/shared'
import { isAgentEnabledForUser } from '../settings'
import type { MunshiDecideJob } from '../agents/munshi/index'
import type { ProcurementTurnJob } from '../agents/procurement/index'

/**
 * Free text on WhatsApp vs the open proposals (audit M42). Buttons carry their
 * run id and are routed before this; a typed / spoken message is bound here by
 * agent-core `bindTextConfirmation` across EVERY agent that can hold an open
 * confirmable proposal for this user on this conversation:
 *
 *   - Munshi: a proposed draft whose card went out here (text window: 30 min
 *     after the latest card; the buttons stay valid for the draft's TTL);
 *   - procurement: the conversation's active session's open proposal;
 *   - support: a nudge offer parked on this user's WhatsApp run (button-only).
 *
 * Only `bound` lets text approve, and then only through the agent's own law
 * (Munshi `isUnambiguousYes`; procurement `readUtteranceOnProposal`). Anything
 * ambiguous re-sends the open cards and approves NOTHING. A reply that quotes
 * one of our cards (WhatsApp `context.id`) binds to exactly that card's run.
 * An active procurement session takes the buyer's other messages as before,
 * with text approval off unless the binding pointed at it.
 */

export interface FreeTextHooks {
  enqueueMunshiDecide?: (job: Omit<MunshiDecideJob, 'kind'>) => Promise<string | null>
  enqueueProcurementTurn?: (job: Omit<ProcurementTurnJob, 'kind'>) => Promise<string | null>
}

export interface FreeTextArgs {
  messageId: string
  conversationId: string
  userId: string
  locale: string
  row: { kind: string; body: string | null; payload: Record<string, unknown> | null }
  procurementSessionId: string | null
  now?: Date
}

export interface OpenProposals {
  open: OpenConfirmable[]
  /** The conversation's procurement session is active and procurement is on for this user. */
  procurementActive: boolean
}

const DAY_MS = 24 * 3600 * 1000
const TEXT_KINDS = new Set(['text', 'audio'])
const ROUTABLE_KINDS = new Set(['text', 'audio', 'image', 'document'])

/** The open confirmable proposals of `userId` on this conversation (see the header). */
export async function openProposalsFor(admin: SupabaseClient, args: Pick<FreeTextArgs, 'conversationId' | 'userId' | 'procurementSessionId' | 'now'>): Promise<OpenProposals> {
  const now = args.now ?? new Date()
  const since = new Date(now.getTime() - DAY_MS).toISOString()
  // when each run's card last went out HERE (Munshi / procurement / support record run_id on their outbound rows)
  const { data: outs } = await admin.from('wa_messages').select('created_at, payload').eq('conversation_id', args.conversationId).eq('direction', 'out').gte('created_at', since).order('created_at', { ascending: false }).limit(100)
  const lastSent = new Map<string, string>()
  for (const o of (outs as { created_at: string; payload: Record<string, unknown> | null }[] | null) ?? []) {
    const run = o.payload?.['run_id']
    if (typeof run === 'string' && !lastSent.has(run)) lastSent.set(run, o.created_at)
  }
  const open: OpenConfirmable[] = []

  const { data: drafts } = await admin.from('munshi_drafts').select('run_id, delivered').eq('user_id', args.userId).eq('status', 'proposed').gt('created_at', since).is('deleted_at', null).order('created_at', { ascending: false }).limit(10)
  for (const d of (drafts as { run_id: string | null; delivered: Record<string, unknown> | null }[] | null) ?? []) {
    if (d.run_id && d.delivered && d.delivered['whatsapp']) open.push({ agent: 'munshi', runId: d.run_id, deliveredAt: lastSent.get(d.run_id) ?? null })
  }

  let procurementActive = false
  if (args.procurementSessionId) {
    const { data: s } = await admin.from('procurement_sessions').select('user_id, state, open_run_id').eq('id', args.procurementSessionId).is('deleted_at', null).maybeSingle()
    const row = s as { user_id: string; state: string; open_run_id: string | null } | null
    if (row && row.user_id === args.userId && procurementSessionIsActive(row.state) && (await isAgentEnabledForUser(admin, 'procurement', args.userId))) {
      procurementActive = true
      if (row.open_run_id) {
        const { data: run } = await admin.from('agent_runs').select('status').eq('id', row.open_run_id).maybeSingle()
        if ((run as { status?: string } | null)?.status === 'awaiting_confirmation') open.push({ agent: 'procurement', runId: row.open_run_id, deliveredAt: lastSent.get(row.open_run_id) ?? null })
      }
    }
  }

  const { data: nudges } = await admin.from('agent_runs').select('id').eq('user_id', args.userId).eq('status', 'awaiting_confirmation').eq('surface', 'whatsapp').eq('meta->>agent', 'support').gte('created_at', since).limit(3)
  for (const r of (nudges as { id: string }[] | null) ?? []) open.push({ agent: 'support', runId: r.id, deliveredAt: lastSent.get(r.id) ?? null })

  return { open, procurementActive }
}

/** The run the reply quotes: WhatsApp context.id → OUR outbound row on this conversation → its payload.run_id. */
export async function quotedRun(admin: SupabaseClient, conversationId: string, payload: Record<string, unknown> | null): Promise<{ quoted: boolean; runId: string | null }> {
  const vid = quotedVendorMessageId(payload)
  if (!vid) return { quoted: false, runId: null }
  const { data } = await admin.from('wa_messages').select('payload').eq('conversation_id', conversationId).eq('vendor_message_id', vid).eq('direction', 'out').maybeSingle()
  if (!data) return { quoted: false, runId: null } // a quote of the user's own message (or an unknown id) is not a quote of a card
  const run = (data as { payload: Record<string, unknown> | null }).payload?.['run_id']
  return { quoted: true, runId: typeof run === 'string' ? run : null }
}

/**
 * Route a text / audio / image / document message given the open proposals.
 * Returns routed = true when a job was enqueued (the dispatcher stops there).
 */
export async function routeFreeText(admin: SupabaseClient, args: FreeTextArgs, hooks: FreeTextHooks): Promise<{ routed: boolean; binding: TextBinding | null }> {
  if (!ROUTABLE_KINDS.has(args.row.kind)) return { routed: false, binding: null }
  const now = args.now ?? new Date()
  const { open, procurementActive } = await openProposalsFor(admin, args)
  const q = await quotedRun(admin, args.conversationId, args.row.payload)
  const binding = bindTextConfirmation({ open, quoted: q.quoted, quotedRunId: q.runId, now, windowMs: DEFAULT_TEXT_WINDOWS })
  const textish = TEXT_KINDS.has(args.row.kind)
  const procurementTurn = async (textApproval: boolean) => {
    if (!hooks.enqueueProcurementTurn || !args.procurementSessionId) return false
    await hooks.enqueueProcurementTurn({ userId: args.userId, surface: 'whatsapp', sessionId: args.procurementSessionId, conversationId: args.conversationId, messageId: args.messageId, textApproval })
    return true
  }
  const reaskMunshi = async (runIds: string[]) => {
    if (!hooks.enqueueMunshiDecide) return 0
    for (const runId of runIds.slice(0, 3)) await hooks.enqueueMunshiDecide({ runId, messageId: args.messageId, action: 'reask' })
    return Math.min(runIds.length, 3)
  }

  if (binding.status === 'bound') {
    const p = binding.proposal
    if (p.agent === 'munshi' && textish && hooks.enqueueMunshiDecide) {
      await hooks.enqueueMunshiDecide({ runId: p.runId, messageId: args.messageId, action: 'utterance', textApproval: true })
      return { routed: true, binding }
    }
    if (p.agent === 'procurement' && (await procurementTurn(true))) return { routed: true, binding }
    // support is button-only; a Munshi card does not take a photo: the ordinary routes below
  } else if (binding.status === 'ambiguous') {
    const munshiRuns = binding.proposals.filter((p) => p.agent === 'munshi').map((p) => p.runId)
    const typedYes = args.row.kind === 'text' && isUnambiguousYes(String(args.row.body ?? ''), args.locale)
    if (procurementActive) {
      // the buyer's session takes the message (its own yes re-sends its card); a typed yes also brings back the Munshi cards
      if (typedYes) await reaskMunshi(munshiRuns)
      if (await procurementTurn(false)) return { routed: true, binding }
    }
    // no session: a yes (or a voice note we cannot read here) re-sends the open Munshi cards — never approves
    if (munshiRuns.length && (typedYes || args.row.kind === 'audio')) {
      if ((await reaskMunshi(munshiRuns)) > 0) return { routed: true, binding }
    }
    return { routed: false, binding }
  }
  // nothing bound: an active procurement session takes the message (text approval off — nothing was bound to it)
  if (procurementActive && (await procurementTurn(false))) return { routed: true, binding }
  return { routed: false, binding }
}
