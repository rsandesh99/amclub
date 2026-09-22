import { z } from 'zod'
import { customerFacingText } from '../../untrusted/output'

/** The smoke-test prompt's reply reaches a user; S2.1 opts it in like every customer-facing schema. */
export const helloSchema = customerFacingText(z.object({
  reply: z.string().min(1).max(120),
  ok: z.literal(true),
}), { fields: ['reply'], forbid: ['contact', 'payment', 'urls'] })
export type Hello = z.infer<typeof helloSchema>
