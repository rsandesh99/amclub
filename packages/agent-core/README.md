# @amclub/agent-core

The library shared by **apps/agent-runtime** (always-on loops/workers) and the
**Vercel functions** (bounded single-shot calls). One gateway, one cost logger,
one injection boundary, one confirm gate. No `next` dependency (ADR-009 §1).

Read `docs/agents/ARCHITECTURE.md` first — this package is the code that makes
its invariants true.

## Modules

| module | what it owns |
|---|---|
| `llm/router` | the ONE tier → model-id mapping (env-driven). `apps/web/lib/agent/router.ts` re-exports `resolveModel` from here. |
| `llm/gateway` | OpenAI-compatible chat/JSON + embeddings; retries, timeout, **stub mode** (no key ⇒ no bill). |
| `prompts/registry` | versioned prompt files `src/prompts/<id>/<version>.md`; `getPrompt` refuses an unknown `id@version`. |
| `untrusted/envelope` | the injection boundary: `envelope()` sanitises + brands third-party text; `assertEnvelope` refuses a raw string; `renderUntrusted` escapes it inside `<untrusted>` tags. |
| `ledger` | the only writer of `agent_runs` / `agent_events` / `ai_invocations` / `ai_decisions` (service role, agent-owned telemetry only). Pure cost math lives here and `apps/web/lib/voice/invocations.ts` re-imports it. |
| `budget` | Upstash counters run / user-day / month, checked before each model call. |
| `auth/runtime-credential` | HMAC the runtime presents to mint a delegated JWT (±5 min window). |
| `whatsapp` | adapter (`meta_cloud` / `interakt` / `stub`), template registry, opt-in keywords; the runtime hosts the webhook, web sends templates. |
| `media/dhash` | 64-bit dHash (pure bit math) + `dhashFromImage` via the OPTIONAL peer `sharp` (clear error when absent). S1.4 duplicate-photo detection. |
| `dossier/checks` | `computeDossierChecks(evidence, findings, duplicates)` — the deterministic S1.4 checks + anomalies; `recommendDossier` (shared) turns them into approve/hold. Fixtures exported for the web verify script. |
| `runner` | `runAgent()` / `AgentRun`: step + money budgets, taint law, the confirm gate (park → `resume` verifies an `ai_decisions` row), tool execution via `fetch(/api/v1)` under the delegated token. |

## Scripts

```bash
pnpm --filter @amclub/agent-core typecheck
pnpm --filter @amclub/agent-core test      # vitest — fakes only, never a network call
pnpm --filter @amclub/agent-core eval       # golden runner; STUB in CI, LIVE where a key exists
```

## Env (all optional in dev; stub mode when the key is absent)

| var | meaning |
|---|---|
| `AGENT_LLM_BASE_URL` | OpenAI-compatible base (default OpenRouter). |
| `AGENT_LLM_API_KEY` / `OPENROUTER_API_KEY` | gateway key; **absent ⇒ stub mode**. |
| `AGENT_LLM_STUB=1` | force stub mode even with a key. |
| `AGENT_MODEL_{LIVE,ROUTINE,REASONING,FRONTIER}` | tier → model id overrides. |
| `AGENT_EMBED_BASE_URL`, `AGENT_MODEL_EMBEDDING` | embeddings route + model. |
| `AGENT_BUDGET_{RUN,USER_DAY,MONTH}_PAISE` | cap overrides (else `agent_settings`, else registry defaults). |

Nothing here is enabled by a flag. Surfaces gate on `AGENT_ENABLED`; each agent
gates on `agent_settings.agents_enabled.<name>` + a cohort allowlist.
