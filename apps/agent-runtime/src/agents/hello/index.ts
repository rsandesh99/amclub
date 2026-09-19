import { getPrompt, helloSchema, type AgentDefinition } from '@amclub/agent-core'

/**
 * The no-op smoke agent (BUILD_PROMPTS S0.1). Proves the runtime, the gateway,
 * the ledger and the budget are wired: one routine model call (stub mode in CI /
 * keyless dev). It carries a confirm-gated `create_rfq` tool for reference but
 * does not call it in the normal path.
 */
export interface HelloInput {
  greeting: string
}
export interface HelloOutput {
  reply: string
}

export const helloAgent: AgentDefinition<HelloInput, HelloOutput> = {
  name: 'hello',
  persona: 'buyer',
  async run(run, input) {
    const prompt = getPrompt('hello', 'v1')
    const out = await run.callModel({
      taskClass: prompt.taskClass,
      prompt,
      schema: helloSchema,
      parts: { trusted: [input.greeting] },
      stub: () => ({ reply: `Hi! Received: ${input.greeting}`.slice(0, 120), ok: true as const }),
    })
    return { reply: out.reply }
  },
}
