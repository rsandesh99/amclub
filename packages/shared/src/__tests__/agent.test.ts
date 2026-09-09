import { describe, expect, it } from 'vitest'
import {
  AGENT_TOOLS,
  AGENT_TASK_CLASSES,
  AGENT_PERSONAS,
  TASK_CLASS_TIER,
  agentTool,
  isToolAllowed,
  requiresConfirmation,
  tierFor,
  toolsForPersona,
  agentToolNameSchema,
  AGENT_RUN_TRANSITIONS,
  isValidAgentRunTransition,
} from '../index'

/**
 * ADR-008 invariants. These are the properties the runtime, the surfaces and
 * reviewers rely on; a change here is a governance change, not a refactor.
 */

describe('agent contract — routing table', () => {
  it('every task class has exactly one tier', () => {
    for (const tc of AGENT_TASK_CLASSES) expect(tierFor(tc)).toBeTruthy()
    expect(Object.keys(TASK_CLASS_TIER).sort()).toEqual([...AGENT_TASK_CLASSES].sort())
  })

  it('no task class routes to the device tier (device work is client-side only)', () => {
    for (const tc of AGENT_TASK_CLASSES) expect(tierFor(tc)).not.toBe('device')
  })
})

describe('agent contract — tools and personas', () => {
  it('tool names are unique and valid enum members', () => {
    const names = AGENT_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(agentToolNameSchema.safeParse(n).success).toBe(true)
  })

  it('every persona has at least one tool and never sees another persona\'s tools', () => {
    for (const p of AGENT_PERSONAS) {
      const mine = toolsForPersona(p)
      expect(mine.length).toBeGreaterThan(0)
      for (const t of AGENT_TOOLS) {
        expect(isToolAllowed(p, t.name)).toBe(t.persona === p)
      }
    }
  })

  it('unknown tool is never allowed', () => {
    for (const p of AGENT_PERSONAS) expect(isToolAllowed(p, 'release_payout')).toBe(false)
  })

  it('every tool that moves money or status requires confirmation', () => {
    const mutating = ['create_rfq', 'accept_quote', 'place_order', 'draft_dispute', 'submit_quote', 'reply_thread'] as const
    for (const t of mutating) expect(requiresConfirmation(t)).toBe(true)
  })

  it('ops persona is recommendation-only: no ops tool requires confirmation because none mutates', () => {
    for (const t of toolsForPersona('ops')) {
      expect(t.confirm).toBe(false)
      expect(t.wraps.startsWith('GET ')).toBe(true)
    }
  })

  it('no tool wraps an admin mutation', () => {
    for (const t of AGENT_TOOLS) {
      expect(t.wraps).not.toMatch(/^(POST|PATCH|PUT|DELETE) \/admin/)
    }
  })

  it('agentTool returns the spec for a known tool', () => {
    expect(agentTool('place_order').wraps).toBe('POST /checkout')
  })
})

describe('agent run state machine', () => {
  it('terminal states have no exits', () => {
    for (const s of ['completed', 'failed', 'cancelled'] as const) {
      expect(AGENT_RUN_TRANSITIONS[s]).toEqual([])
    }
  })
  it('confirmation gate round-trips and can be declined', () => {
    expect(isValidAgentRunTransition('running', 'awaiting_confirmation')).toBe(true)
    expect(isValidAgentRunTransition('awaiting_confirmation', 'running')).toBe(true)
    expect(isValidAgentRunTransition('awaiting_confirmation', 'cancelled')).toBe(true)
    expect(isValidAgentRunTransition('completed', 'running')).toBe(false)
  })
})
