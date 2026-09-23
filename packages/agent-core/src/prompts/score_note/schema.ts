import { z } from 'zod'
import { scoreNoteSchema as bare, SCORE_NOTE_PROMISE_PHRASES } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * `score_note@v1` (S2.4) — the provider's own coaching sentence. Provider-facing, so the full customer-facing
 * contract applies (contact / payment / ranking / approval / urls) plus the promise list: a score never guarantees
 * work. The numbers rule (only input numbers) needs the input, so the caller checks it with `scoreNoteProblems`.
 */
export const scoreNoteSchema = customerFacingText(bare, { fields: ['note'], forbid: ['contact', 'payment', 'ranking', 'approval', 'urls'] }).superRefine((v, ctx) => {
  const lower = v.note.toLowerCase()
  for (const list of Object.values(SCORE_NOTE_PROMISE_PHRASES)) {
    for (const p of list) if (lower.includes(p.toLowerCase())) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: 'promise_language', params: { violation: 'promise_language', match: p } })
  }
})
export type { ScoreNote } from '@amclub/shared'
