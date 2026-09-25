/**
 * Audit M42 — which open proposal may a typed / spoken WhatsApp "yes" confirm?
 *
 * Buttons carry their run id, so a tap is never ambiguous. Free text is: one user
 * can be a provider (Munshi drafts) AND a buyer (a procurement proposal) AND have
 * a support nudge offer open, all on one conversation. A "yes" meant for one must
 * never approve another. The rule (code, never a model):
 *
 *  1. The reply QUOTES one of our messages (WhatsApp `context.id` → our outbound
 *     row → its run id): bound to that proposal when it is still open; when it is
 *     not (a closed / other proposal), ambiguous — never another proposal.
 *  2. Otherwise exactly ONE open confirmable proposal across every agent, delivered
 *     inside its agent's text window: bound to it.
 *  3. Anything else (two or more open, or the only one outside its window):
 *     ambiguous — the surface re-sends the buttons and approves nothing.
 *
 * `bound` is the ONLY status under which text may approve; the agent still applies
 * its own law after that (Munshi: `isUnambiguousYes`; procurement:
 * `readUtteranceOnProposal`, button-only tools stay button-only).
 */

export type ConfirmAgent = 'munshi' | 'procurement' | 'support'

export interface OpenConfirmable {
  agent: ConfirmAgent
  runId: string
  /** When the proposal's card (or a re-sent card) last went out on this conversation (ISO); null = never on WhatsApp. */
  deliveredAt: string | null
}

export interface TextBindingInput {
  open: readonly OpenConfirmable[]
  /** True when the inbound reply quotes one of OUR outbound messages. */
  quoted: boolean
  /** The run id that quoted outbound message carried (null when it had none). */
  quotedRunId: string | null
  now: Date
  /** Per agent: how long after the card went out a free-text yes may still bind (ms). Absent / null = no limit. */
  windowMs?: Partial<Record<ConfirmAgent, number | null>>
}

export type TextBinding =
  | { status: 'bound'; proposal: OpenConfirmable; via: 'quoted' | 'only_open' }
  | { status: 'ambiguous'; reason: 'several_open' | 'outside_window' | 'quoted_other'; proposals: OpenConfirmable[] }
  | { status: 'none' }

/** Munshi's free-text window (audit M42: was the whole 24 h draft TTL). The buttons stay valid for the TTL. */
export const MUNSHI_TEXT_WINDOW_MS = 30 * 60 * 1000

export const DEFAULT_TEXT_WINDOWS: Partial<Record<ConfirmAgent, number | null>> = { munshi: MUNSHI_TEXT_WINDOW_MS }

function withinWindow(p: OpenConfirmable, now: Date, windowMs: Partial<Record<ConfirmAgent, number | null>>): boolean {
  const w = windowMs[p.agent]
  if (w === undefined || w === null) return true
  if (!p.deliveredAt) return false
  const at = new Date(p.deliveredAt).getTime()
  return Number.isFinite(at) && now.getTime() - at <= w
}

export function bindTextConfirmation(input: TextBindingInput): TextBinding {
  const windows = input.windowMs ?? DEFAULT_TEXT_WINDOWS
  // one entry per run (a card re-sent is still one proposal; its window counts from the LATEST send)
  const byRun = new Map<string, OpenConfirmable>()
  for (const p of input.open) {
    const prev = byRun.get(p.runId)
    const later = !prev || (p.deliveredAt !== null && (prev.deliveredAt === null || new Date(p.deliveredAt).getTime() > new Date(prev.deliveredAt).getTime()))
    if (later) byRun.set(p.runId, p)
  }
  const open = [...byRun.values()]
  if (open.length === 0) return { status: 'none' }
  if (input.quoted) {
    const hit = input.quotedRunId ? open.find((p) => p.runId === input.quotedRunId) : undefined
    return hit ? { status: 'bound', proposal: hit, via: 'quoted' } : { status: 'ambiguous', reason: 'quoted_other', proposals: open }
  }
  if (open.length > 1) return { status: 'ambiguous', reason: 'several_open', proposals: open }
  const only = open[0]!
  return withinWindow(only, input.now, windows) ? { status: 'bound', proposal: only, via: 'only_open' } : { status: 'ambiguous', reason: 'outside_window', proposals: open }
}
