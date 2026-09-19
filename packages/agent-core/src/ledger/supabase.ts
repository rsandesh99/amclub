import type { SupabaseClient } from '@supabase/supabase-js'
import {
  aiDecisionCorrectedFields,
  isValidAgentRunTransition,
  type AgentRunStatus,
} from '@amclub/shared'
import type {
  AgentEventInput,
  ApprovedDecisionQuery,
  DecisionInput,
  InvocationInput,
  Ledger,
  OpenRunInput,
  RunRow,
} from './types'

/**
 * Ledger backed by a SERVICE-ROLE Supabase client. This is the only place the
 * service role writes, and it writes ONLY agent-owned telemetry (agent_runs,
 * agent_events, ai_invocations, ai_decisions) — never user data (ARCHITECTURE.md
 * §2). Every user-data mutation goes back through /api/v1 under the delegated
 * token, driven by the runner.
 */

const TERMINAL: AgentRunStatus[] = ['completed', 'failed', 'cancelled']

export function createSupabaseLedger(admin: SupabaseClient): Ledger {
  return {
    async openRun(input: OpenRunInput) {
      const { data, error } = await admin
        .from('agent_runs')
        .insert({
          user_id: input.userId,
          persona: input.persona,
          surface: input.surface,
          status: 'running',
          subject_type: input.subjectType ?? null,
          subject_id: input.subjectId ?? null,
          parent_run_id: input.parentRunId ?? null,
          job_id: input.jobId ?? null,
          meta: input.meta ?? null,
        })
        .select('id')
        .single()
      if (error) throw new Error(`openRun: ${error.message}`)
      return { id: (data as { id: string }).id }
    },

    async getRun(runId: string): Promise<RunRow | null> {
      const { data, error } = await admin
        .from('agent_runs')
        .select('id, user_id, persona, status, surface, cost_est_paise, input_tokens, output_tokens')
        .eq('id', runId)
        .maybeSingle()
      if (error) throw new Error(`getRun: ${error.message}`)
      if (!data) return null
      const r = data as Record<string, unknown>
      return {
        id: r['id'] as string,
        userId: r['user_id'] as string,
        persona: r['persona'] as RunRow['persona'],
        status: r['status'] as AgentRunStatus,
        surface: r['surface'] as string,
        costEstPaise: Number(r['cost_est_paise'] ?? 0),
        inputTokens: Number(r['input_tokens'] ?? 0),
        outputTokens: Number(r['output_tokens'] ?? 0),
      }
    },

    async transitionRun(runId, from, to, patch) {
      if (!isValidAgentRunTransition(from, to)) {
        throw new Error(`illegal agent_run transition ${from} -> ${to}`)
      }
      const update: Record<string, unknown> = { status: to }
      if (patch?.error !== undefined) update['error'] = patch.error
      if (TERMINAL.includes(to)) update['completed_at'] = new Date().toISOString()
      // Guarded on the expected current status -> replay-safe, and terminal
      // states (no exits) can never be moved because `from` will not match.
      const { data, error } = await admin
        .from('agent_runs')
        .update(update)
        .eq('id', runId)
        .eq('status', from)
        .select('id')
      if (error) throw new Error(`transitionRun: ${error.message}`)
      if (!data || (data as unknown[]).length === 0) {
        throw new Error(`transitionRun: run ${runId} was not in status '${from}' (lost or already advanced)`)
      }
    },

    async addRunCost(runId, cost) {
      // Best-effort display counters (the authoritative budget is Upstash).
      const { data } = await admin
        .from('agent_runs')
        .select('cost_est_paise, input_tokens, output_tokens')
        .eq('id', runId)
        .maybeSingle()
      const cur = (data ?? {}) as Record<string, unknown>
      await admin
        .from('agent_runs')
        .update({
          cost_est_paise: Number(cur['cost_est_paise'] ?? 0) + Math.max(0, cost.costPaise),
          input_tokens: Number(cur['input_tokens'] ?? 0) + Math.max(0, cost.inputTokens),
          output_tokens: Number(cur['output_tokens'] ?? 0) + Math.max(0, cost.outputTokens),
        })
        .eq('id', runId)
    },

    async appendEvent(input: AgentEventInput) {
      const { error } = await admin.from('agent_events').insert({
        run_id: input.runId,
        kind: input.kind,
        tool: input.tool ?? null,
        actor: input.actor ?? 'agent',
        payload: input.payload ?? null,
      })
      if (error) throw new Error(`appendEvent: ${error.message}`)
    },

    async logInvocation(input: InvocationInput) {
      // Telemetry is best-effort: never break a run on a logging failure.
      const { error } = await admin.from('ai_invocations').insert({
        user_id: input.userId,
        feature: input.feature ?? 'agent',
        step: input.taskClass,
        vendor: input.vendor,
        status: input.status,
        latency_ms: input.latencyMs,
        cost_est_paise: input.costEstPaise,
        run_id: input.runId,
        task_class: input.taskClass,
        tier: input.tier,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        meta: input.meta ?? null,
      })
      if (error) console.error('[agent-core ledger] logInvocation:', error.message)
    },

    async recordDecision(input: DecisionInput) {
      const { data, error } = await admin
        .from('ai_decisions')
        .insert({
          feature: input.feature,
          run_id: input.runId ?? null,
          tool: input.tool ?? null,
          input_refs: input.inputRefs,
          proposed: input.proposed,
          final: input.final,
          corrected_fields: aiDecisionCorrectedFields(input.proposed, input.final),
          decided_by: input.decidedBy,
        })
        .select('id')
        .single()
      if (error) throw new Error(`recordDecision: ${error.message}`)
      return { id: (data as { id: string }).id }
    },

    async hasApprovedDecision(q: ApprovedDecisionQuery) {
      // An ai_decisions row bound to (run_id, tool) IS the approval — a decline
      // is recorded as an event + run transition, never a decisions row.
      let query = admin.from('ai_decisions').select('id').eq('run_id', q.runId).eq('tool', q.tool)
      if (q.decisionId) query = query.eq('id', q.decisionId)
      const { data, error } = await query.limit(1)
      if (error) throw new Error(`hasApprovedDecision: ${error.message}`)
      return Array.isArray(data) && data.length > 0
    },
  }
}
