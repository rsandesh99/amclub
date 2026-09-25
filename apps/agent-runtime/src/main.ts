import { loadDefaultPrompts } from '@amclub/agent-core'
import { startServer } from './server'
import { startWorker } from './worker'

/**
 * Entrypoint. Registers the shipped prompts, starts the persistent job worker
 * (disabled without DATABASE_URL — /health says so), then serves the internal
 * HTTP surface. On Fly this is one always-on machine (region bom); rollback =
 * scale to 0.
 *
 * Audit M33: a worker that fails to START exits the process (Fly restarts the
 * machine) — it used to log and keep serving, so the webhook stored WhatsApp
 * messages that no job ever read while /health stayed green.
 */
async function main(): Promise<void> {
  loadDefaultPrompts()
  try {
    await startWorker()
  } catch (e) {
    console.error('[worker] failed to start — exiting so the platform restarts the machine', e)
    process.exit(1)
  }
  startServer()
}

main().catch((e) => {
  console.error('[agent-runtime] fatal', e)
  process.exit(1)
})
