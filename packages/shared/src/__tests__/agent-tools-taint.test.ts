import { describe, expect, it } from 'vitest'
import { AGENT_EVENT_KINDS, AGENT_TASK_CLASSES, AGENT_TOOLS, agentEventKindSchema } from '../agent'

/**
 * S2.1 — the taint law as a test over the registry (ARCHITECTURE.md §4):
 * after untrusted content enters a run, no confirm:false tool may write
 * anything. The runner enforces it at proposeTool; this test enforces the
 * registry shape that makes the runner's check sufficient.
 */
describe('S2.1 taint law over AGENT_TOOLS', () => {
  it('every confirm:false tool wraps a GET or a pure local computation', () => {
    for (const t of AGENT_TOOLS) {
      if (t.confirm) continue
      expect(t.wraps.startsWith('GET ') || t.wraps.startsWith('local'), `${t.name} (${t.persona}) wraps "${t.wraps}"`).toBe(true)
    }
  })

  it('every confirm:true tool wraps a POST, PATCH or local confirm — never a GET', () => {
    for (const t of AGENT_TOOLS) {
      if (!t.confirm) continue
      expect(/^(POST|PATCH|local)\b/.test(t.wraps), `${t.name} (${t.persona}) wraps "${t.wraps}"`).toBe(true)
    }
  })

  it('every taskClass on a tool is a registered task class', () => {
    for (const t of AGENT_TOOLS) {
      if (!('taskClass' in t) || !t.taskClass) continue
      expect(AGENT_TASK_CLASSES as readonly string[], `${t.name}: ${t.taskClass}`).toContain(t.taskClass)
    }
  })

  it('tool names are unique per persona and personas are the three known ones', () => {
    const seen = new Set<string>()
    for (const t of AGENT_TOOLS) {
      const key = `${t.persona}:${t.name}`
      expect(seen.has(key), key).toBe(false)
      seen.add(key)
      expect(['buyer', 'provider', 'ops']).toContain(t.persona)
    }
  })

  it('ops tools are read-only recommendations: no confirm:true ops tool, every ops wrap is a GET', () => {
    for (const t of AGENT_TOOLS.filter((x) => x.persona === 'ops')) {
      expect(t.confirm, t.name).toBe(false)
      expect(t.wraps.startsWith('GET '), `${t.name} wraps "${t.wraps}"`).toBe(true)
    }
  })

  it('injection_suspected is a registered event kind (0039 restates the CHECK with it)', () => {
    expect(AGENT_EVENT_KINDS).toContain('injection_suspected')
    expect(agentEventKindSchema.safeParse('injection_suspected').success).toBe(true)
  })
})
