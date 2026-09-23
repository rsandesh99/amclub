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
  agentGrantSchema,
  scopesWithinPersona,
  AGENT_SURFACES,
  AGENT_CHANNELS,
  AGENT_RESIDENCIES,
  TASK_CLASS_RESIDENCY,
  residencyFor,
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
  it('tool names are unique PER PERSONA (S2.3: support_lookup / nudge_counterparty exist for buyer and provider) and valid enum members', () => {
    const keys = AGENT_TOOLS.map((t) => `${t.persona}:${t.name}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const t of AGENT_TOOLS) expect(agentToolNameSchema.safeParse(t.name).success).toBe(true)
    // a repeated name must carry the SAME confirm + wraps shape for every persona (one route contract per name)
    const byName = new Map<string, { confirm: boolean; wraps: string }>()
    for (const t of AGENT_TOOLS) {
      const prev = byName.get(t.name)
      if (prev) expect({ confirm: t.confirm, wraps: t.wraps }, t.name).toEqual(prev)
      else byName.set(t.name, { confirm: t.confirm, wraps: t.wraps })
    }
  })

  it('every persona has at least one tool and never sees another persona\'s tools', () => {
    for (const p of AGENT_PERSONAS) {
      const mine = toolsForPersona(p)
      expect(mine.length).toBeGreaterThan(0)
      for (const t of AGENT_TOOLS) {
        expect(isToolAllowed(p, t.name)).toBe(AGENT_TOOLS.some((x) => x.name === t.name && x.persona === p))
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

  it('every confirm:false tool is read-only or local (a GET or a local computation)', () => {
    for (const t of AGENT_TOOLS) {
      if (t.confirm) continue
      expect(t.wraps.startsWith('GET ') || t.wraps.startsWith('local'), `${t.name} wraps ${t.wraps}`).toBe(true)
    }
    // S1.4: the ops evidence read is exactly that — a GET.
    expect(agentTool('read_order_evidence').wraps).toBe('GET /admin/orders/[id]/evidence')
    expect(agentTool('read_order_evidence').confirm).toBe(false)
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

describe('delegation grant — scopes are a subset of the persona allowlist', () => {
  it('accepts scopes that are the persona\'s own tools', () => {
    const r = agentGrantSchema.safeParse({ persona: 'buyer', scopes: ['search_catalog', 'create_rfq'], channel: 'whatsapp', channel_identity: '+919876543210' })
    expect(r.success).toBe(true)
  })

  it('rejects a scope from another persona (the injection boundary)', () => {
    const r = agentGrantSchema.safeParse({ persona: 'buyer', scopes: ['submit_quote'], channel: 'web' })
    expect(r.success).toBe(false)
  })

  it('rejects an unknown scope', () => {
    const r = agentGrantSchema.safeParse({ persona: 'ops', scopes: ['release_payout'], channel: 'web' })
    expect(r.success).toBe(false)
  })

  it('defaults scopes to empty and allows an empty grant', () => {
    const r = agentGrantSchema.safeParse({ persona: 'provider', channel: 'mobile' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.scopes).toEqual([])
  })

  it('scopesWithinPersona matches the schema decision', () => {
    expect(scopesWithinPersona('buyer', ['search_catalog'])).toBe(true)
    expect(scopesWithinPersona('buyer', ['submit_quote'])).toBe(false)
  })

  it('grant channels never include phone or system; surfaces do', () => {
    expect([...AGENT_CHANNELS]).toEqual(['web', 'mobile', 'whatsapp'])
    expect(AGENT_SURFACES).toContain('system')
    expect(AGENT_SURFACES).toContain('phone')
    for (const c of AGENT_CHANNELS) expect(AGENT_SURFACES).toContain(c)
  })
})

describe('task class residency (DPDP guard input)', () => {
  it('every task class has a residency', () => {
    for (const c of AGENT_TASK_CLASSES) expect(AGENT_RESIDENCIES).toContain(TASK_CLASS_RESIDENCY[c])
  })

  it('classes that carry user documents, transcripts, onboarding answers, drafts or dispute text are in-India', () => {
    for (const c of ['speech_to_text', 'rfq_parse', 'document_extract', 'quote_extract', 'quote_draft', 'onboarding_interview', 'dispute_triage', 'dispute_summary', 'support_intent', 'thread_reply', 'photo_plausibility'] as const) {
      expect(residencyFor(c)).toBe('in')
    }
  })

  it('only derived / platform-copy classes may leave India', () => {
    const any = AGENT_TASK_CLASSES.filter((c) => TASK_CLASS_RESIDENCY[c] === 'any').sort()
    expect(any).toEqual(['benchmark_explain', 'translation'])
  })
})
