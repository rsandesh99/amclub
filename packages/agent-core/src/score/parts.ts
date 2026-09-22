import { PROVIDER_COMPONENTS, type ComponentResult, type ProviderComponent } from '@amclub/shared'
import type { ChatParts } from '../llm/gateway'

/**
 * S2.4 — `score_note@v1` parts. TRUSTED ONLY: the score, the components (value + weight), the weakest keys and the
 * tip keys, all platform numbers and fixed identifiers. There is deliberately no untrusted slot — no user text
 * reaches this prompt (the red-team gate checks the output policy only).
 */
export interface ScoreNoteInput {
  locale: string
  score: number | null
  gated: boolean
  gate: { closed_orders: number; needed: number }
  components: Record<ProviderComponent, ComponentResult>
  weakest: readonly ProviderComponent[]
}

export function buildScoreNoteParts(input: ScoreNoteInput): ChatParts {
  const lines = [
    `locale: ${input.locale}`,
    input.gated || input.score === null ? `score: not enough orders yet (${input.gate.closed_orders} of ${input.gate.needed} closed orders)` : `score: ${input.score} of 100`,
    ...PROVIDER_COMPONENTS.map((k) => {
      const c = input.components[k]
      return `component ${k}: ${c?.value === null || c?.value === undefined ? 'no data yet' : `${c.value} of 100`} (weight ${c?.weight ?? 0})`
    }),
    `weakest: ${input.weakest.length ? input.weakest.join(', ') : 'none'}`,
    `tips shown on the card: ${input.weakest.map((k) => `tip.${k}`).join(', ') || 'none'}`,
  ]
  return { trusted: lines, untrusted: [] }
}

/** The numbers a note may use: the score, every component value and weight, the gate counts. */
export function scoreNoteAllowedNumbers(input: ScoreNoteInput): number[] {
  const out: number[] = [100, input.gate.closed_orders, input.gate.needed]
  if (input.score !== null) out.push(input.score)
  for (const k of PROVIDER_COMPONENTS) {
    const c = input.components[k]
    if (c?.value !== null && c?.value !== undefined) out.push(c.value)
    if (c) out.push(c.weight)
  }
  return out
}
