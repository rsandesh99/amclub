import { loadDefaultPrompts } from '@amclub/agent-core'
import { startServer } from './server'
import { startWorker } from './worker'

/**
 * Entrypoint. Registers the shipped prompts, starts the persistent job worker
 * (no-op without DATABASE_URL), then serves the internal HTTP surface. On Fly
 * this is one always-on machine (region bom); rollback = scale to 0.
 */
async function main(): Promise<void> {
  loadDefaultPrompts()
  await startWorker().catch((e) => console.error('[worker] failed to start', e))
  startServer()
}

main().catch((e) => {
  console.error('[agent-runtime] fatal', e)
  process.exit(1)
})
