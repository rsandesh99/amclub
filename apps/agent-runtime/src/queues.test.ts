import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_QUEUES, Q } from './queues'

/**
 * Audit M32 — every queue the worker sends to, works or schedules has been
 * created. pg-boss v10 drops a send to a queue that was never created (it
 * returns null), which is how the weekly `agent.munshi.growth` job vanished.
 */

// the worker module builds its deps lazily; give the service-role client a syntactically valid config
process.env['NEXT_PUBLIC_SUPABASE_URL'] ??= 'http://127.0.0.1:1'
process.env['SUPABASE_SERVICE_ROLE_KEY'] ??= 'test-key'

interface Call { op: 'create' | 'work' | 'send' | 'schedule'; name: string; options?: Record<string, unknown> }

function fakeBoss(opts: { dropSendsTo?: string[]; collide?: boolean } = {}) {
  const calls: Call[] = []
  const created = new Set<string>()
  const boss = {
    async start() {},
    async stop() {},
    on() {},
    async createQueue(name: string, options?: Record<string, unknown>) {
      created.add(name)
      calls.push({ op: 'create', name, ...(options ? { options } : {}) })
    },
    async getQueue(name: string) {
      return created.has(name) ? { name } : null
    },
    async work(name: string) {
      calls.push({ op: 'work', name })
    },
    async send(name: string, _data: object, options?: Record<string, unknown>) {
      calls.push({ op: 'send', name, ...(options ? { options } : {}) })
      // pg-boss: no queue row → nothing inserted; a singleton collision → nothing inserted
      if (!created.has(name) || opts.dropSendsTo?.includes(name)) return null
      if (opts.collide && options?.['singletonKey']) return null
      return `job-${calls.length}`
    },
    async schedule(name: string) {
      if (!created.has(name)) throw new Error(`Queue ${name} not found`)
      calls.push({ op: 'schedule', name })
    },
  }
  return { boss, calls, created }
}

const UUID = '10000000-0000-4000-8000-000000000001'

test('every queue the worker works, schedules or sends to was created first (the registry is complete)', async () => {
  const w = await import('./worker')
  const { boss, calls, created } = fakeBoss()
  await w.startWorker({ boss })
  // the enqueue paths: the web crons, the web triggers, and the dispatcher hooks
  for (const name of ['munshi.scan', 'munshi.followup', 'munshi.growth', 'procurement.watch'] as const) await w.enqueueJob(name, {})
  await w.enqueueJob('payout_dossier', { open: { userId: UUID, surface: 'system' }, input: {} })
  await w.enqueueJob('dispute_triage', { open: { userId: UUID, surface: 'system' }, input: {} })
  await w.enqueueJob('hello', { open: { userId: UUID, surface: 'system' }, input: {} })
  await w.enqueueJob('onboarding', { kind: 'start', sessionId: UUID })
  await w.enqueueJob('procurement.turn', { userId: UUID, turnId: UUID, sessionId: null, surface: 'web' })
  await w.enqueueJob('procurement.decide', { runId: UUID, userId: UUID, action: 'ok' })
  await w.enqueueMunshiDecideJob({ runId: UUID, messageId: UUID, action: 'reask' })
  await w.enqueueSupportReplyJob({ conversationId: UUID, messageId: UUID })
  await w.enqueueSupportDecideJob({ runId: UUID, messageId: UUID, action: 'yes' })
  await w.enqueueProcurementTurnJob({ userId: UUID, surface: 'whatsapp', sessionId: UUID })
  await w.enqueueProcurementDecideJob({ runId: UUID, userId: UUID, action: 'ok', via: 'whatsapp_button' })
  await w.enqueueWaInbound(UUID)

  const used = calls.filter((c) => c.op !== 'create')
  for (const c of used) assert.ok(created.has(c.name), `${c.op} on '${c.name}' but the queue was never created`)
  assert.ok(used.some((c) => c.op === 'send' && c.name === Q.munshiGrowth.name), 'the weekly growth job is sent')
  assert.ok(used.some((c) => c.op === 'work' && c.name === Q.munshiGrowth.name), 'the weekly growth job is worked')
  assert.ok(used.some((c) => c.op === 'schedule' && c.name === Q.waSweep.name), 'the inbound sweep is scheduled')
  for (const q of ALL_QUEUES) assert.ok(created.has(q.name), `registry queue ${q.name} created`)
  // the inbound job id IS the message id (one job per message, ever)
  assert.equal(used.find((c) => c.op === 'send' && c.name === Q.waInbound.name)?.options?.['id'], UUID)
  assert.equal(w.workerHealth().state, 'running')
  await w.stopWorker()
})

test('a send that inserts nothing is an error unless it is a singleton collision', async () => {
  const w = await import('./worker')
  const dropped = fakeBoss({ dropSendsTo: [Q.dossier.name] })
  await w.startWorker({ boss: dropped.boss })
  await assert.rejects(() => w.enqueueJob('payout_dossier', { open: { userId: UUID, surface: 'system' }, input: {} }), /enqueue_dropped:agent\.payout_dossier/)
  await w.stopWorker()

  const colliding = fakeBoss({ collide: true })
  await w.startWorker({ boss: colliding.boss })
  assert.deepEqual(await w.enqueueJob('munshi.growth', {}), { jobId: null, deduped: true })
  await w.stopWorker()
})

test('a worker that cannot start reports failed and rethrows (main exits so the platform restarts it)', async () => {
  const w = await import('./worker')
  const { boss } = fakeBoss()
  const broken = { ...boss, async start() { throw new Error('connection refused') } }
  await assert.rejects(() => w.startWorker({ boss: broken }), /connection refused/)
  assert.equal(w.workerHealth().state, 'failed')
  assert.match(w.workerHealth().lastError?.message ?? '', /connection refused/)
})

// ── static: no queue name outside the registry ───────────────────────────────

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sources(full))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

test('every boss.send / work / schedule in src names a registry queue (Q.<key>.name), never a string literal', () => {
  const src = join(__dirname)
  const keys = new Set(Object.keys(Q))
  const bad: string[] = []
  for (const file of sources(src)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      // the one generic forwarder (its callers are checked instead) carries this marker
      if (line.includes('queue-registry: forwarded')) continue
      const re = /\b(?:(?:boss|b)\??\.(send|work|schedule|sendAfter|sendThrottled|sendDebounced|insert)|(sendOrThrow))\s*(?:<[^>(]*>)?\(\s*([^,\s)]+)/g
      for (const m of line.matchAll(re)) {
        const arg = m[3]!
        if (m[2] && arg === 'name:') continue // the function's own declaration
        const k = /^Q\.(\w+)\.name$/.exec(arg)?.[1]
        if (!k || !keys.has(k)) bad.push(`${file.slice(src.length + 1)}: ${m[1] ?? m[2]}(${arg})`)
      }
    }
  }
  assert.deepEqual(bad, [], `queue names must come from the registry:\n${bad.join('\n')}`)
})
