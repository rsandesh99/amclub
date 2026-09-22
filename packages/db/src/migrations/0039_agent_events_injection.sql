-- Prompt-injection hardening kit + red-team gate (BUILD_PROMPTS S2.1) — additive,
-- idempotent, NOT staged (apply to prod before the writer deploys, RULES.md 2).
--
-- One new agent_events.kind: 'injection_suspected' — the runner appends it when
-- an untrusted part scored ≥ 40 on the instruction-pattern detector (payload
-- { provenance: { kind, id }, score, hits, prompt }). Detect and log, never
-- block: the model still sees the content inside the <untrusted> tags. The
-- CHECK is restated in full (AGENT_EVENT_KINDS in packages/shared/src/agent.ts).
-- Rollback: drop and re-add the CHECK without the new value (additive; no row
-- carries it until the S2.1 runner deploys).

ALTER TABLE agent_events DROP CONSTRAINT IF EXISTS agent_events_kind_check;
--> statement-breakpoint
ALTER TABLE agent_events ADD CONSTRAINT agent_events_kind_check CHECK (kind IN (
  'started', 'model_call', 'tool_proposed', 'confirmation_requested',
  'confirmed', 'declined', 'tool_called', 'completed', 'failed', 'cancelled',
  'injection_suspected'
));
