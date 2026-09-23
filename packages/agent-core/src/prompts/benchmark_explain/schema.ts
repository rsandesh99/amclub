import { z } from 'zod'
import { BENCHMARK_NOTE_BANNED, benchmarkExplainSchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * `benchmark_explain@v1` (S3.2) — one plain sentence explaining what a fair price range means. Both buyers and
 * providers read it, so the full customer-facing contract applies (contact / payment / ranking / approval / urls) plus
 * the advice list in every locale: it never says what anyone should charge or pay. The numbers rule (only the row's
 * numbers) needs the row, so the caller also checks `benchmarkNoteViolations`.
 */
export const benchmarkExplainSchema = customerFacingText(bare, { fields: ['note'], forbid: ['contact', 'payment', 'ranking', 'approval', 'urls'] }).superRefine((v, ctx) => {
  const lower = v.note.normalize('NFKC').toLowerCase()
  for (const list of Object.values(BENCHMARK_NOTE_BANNED)) {
    for (const w of list) {
      const needle = w.normalize('NFKC').toLowerCase()
      const hit = /^[a-z -]+$/.test(needle) ? new RegExp(`(^|[^a-z])${needle}`).test(lower) : lower.includes(needle)
      if (hit) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: 'advice_language', params: { violation: 'advice_language', match: w } })
    }
  }
})
export type { BenchmarkExplain } from '@amclub/shared'
