import { stateName, type BenchmarkView } from '@amclub/shared'
import type { ChatParts } from '../llm/gateway'

/**
 * S3.2 — `benchmark_explain@v1` parts. TRUSTED ONLY: the row's numbers (computed by code from paid orders), the scope,
 * the state name and the viewer's locale. There is deliberately no untrusted slot — no user text reaches this prompt
 * (the red-team gate checks the output policy only). The model never produces or changes a number: the caller rejects
 * any sentence with a number outside the row (`benchmarkNoteViolations`).
 */
export type BenchmarkExplainInput = Pick<BenchmarkView, 'scope' | 'state' | 'p25_paise' | 'p50_paise' | 'p75_paise' | 'median_delivery_days' | 'p25_delivery_days' | 'p75_delivery_days' | 'sample_n' | 'providers_n'> & { locale: string }

const rupees = (paise: number): string => `₹${(paise / 100).toLocaleString('en-IN')}`

export function buildBenchmarkExplainParts(input: BenchmarkExplainInput): ChatParts {
  const place = input.scope === 'state' ? (stateName(input.state) ?? 'this state') : 'across India'
  const lines = [
    `locale: ${input.locale}`,
    `where: ${place}`,
    `paid jobs in the sample: ${input.sample_n}`,
    `providers in the sample: ${input.providers_n}`,
    `25th percentile price: ${rupees(input.p25_paise)}`,
    `median price: ${rupees(input.p50_paise)}`,
    `75th percentile price: ${rupees(input.p75_paise)}`,
    input.p25_delivery_days != null && input.p75_delivery_days != null
      ? `delivery days: 25th percentile ${input.p25_delivery_days}, median ${input.median_delivery_days ?? input.p25_delivery_days}, 75th percentile ${input.p75_delivery_days}`
      : 'delivery days: not enough delivered jobs to say',
  ]
  return { trusted: lines, untrusted: [] }
}
