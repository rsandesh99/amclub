/**
 * Prompt golden runner (ADR-009 §5). Runs in STUB mode when no LLM key is
 * configured (CI, keyless dev) and in LIVE mode where a key exists, so the same
 * command proves the prompt registry + gateway + schema pipeline in CI and
 * validates real model output when a key is present. Exits non-zero on any
 * failure. S0.1 ships the `hello@v1` smoke set; each later prompt adds its own.
 *
 * Run: pnpm --filter @amclub/agent-core eval
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createGateway,
  gatewayConfigFromEnv,
  getPrompt,
  loadDefaultPrompts,
} from '../src/index'
import { helloSchema } from '../src/prompts/hello/schema'

interface HelloCase {
  input: string
  expectOk: boolean
}

async function main() {
  loadDefaultPrompts()
  const cfg = gatewayConfigFromEnv()
  const gateway = createGateway(cfg)
  const live = !cfg.forceStub && !!cfg.apiKey
  const here = dirname(fileURLToPath(import.meta.url))
  const cases = JSON.parse(readFileSync(join(here, '../golden/hello.json'), 'utf8')) as HelloCase[]
  const prompt = getPrompt('hello', 'v1')

  let pass = 0
  let fail = 0
  for (const c of cases) {
    try {
      const res = await gateway.chatJson({
        taskClass: prompt.taskClass,
        prompt,
        schema: helloSchema,
        parts: { trusted: [c.input] },
        stub: () => ({ reply: `Hi! Received: ${c.input}`.slice(0, 120), ok: true as const }),
      })
      if (res.data.ok === c.expectOk && res.data.reply.length > 0) {
        pass++
        console.log(`  ✓ ${live ? 'live' : 'stub'}  ${JSON.stringify(c.input)} -> ${JSON.stringify(res.data.reply).slice(0, 60)}`)
      } else {
        fail++
        console.error(`  ✗ ${JSON.stringify(c.input)} -> unexpected ${JSON.stringify(res.data)}`)
      }
    } catch (e) {
      fail++
      console.error(`  ✗ ${JSON.stringify(c.input)} -> ${(e as Error).message}`)
    }
  }
  console.log(`\n${fail === 0 ? '✅' : '❌'} hello@v1: ${pass} passed, ${fail} failed (${live ? 'LIVE' : 'STUB'} mode)\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
