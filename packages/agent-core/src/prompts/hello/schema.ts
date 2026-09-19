import { z } from 'zod'

/**
 * Output schema for the `hello@v1` smoke-test prompt (schemaRef: helloSchema).
 * Imported by the eval golden runner and by the runtime's hello agent, so the
 * contract is defined once.
 */
export const helloSchema = z.object({
  reply: z.string().min(1).max(120),
  ok: z.literal(true),
})
export type Hello = z.infer<typeof helloSchema>
