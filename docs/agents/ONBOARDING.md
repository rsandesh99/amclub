# ONBOARDING.md — the Onboarding agent (S1.6)

**What it is.** A provider who signed up by phone OTP finishes onboarding on
WhatsApp, in their own language, through a **scripted interview**: business
name, GSTIN and Udyam (format-checked only), up to three categories by
buttons, three capability answers per category by text or voice note, and up
to five workshop photos. **One** reasoning-tier model call turns the transcript
into a profile draft plus one to three listing drafts. The provider confirms
the draft with a WhatsApp **button** — that tap is the confirmation and writes
one `ai_decisions` row (feature `onboarding`, tool `confirm_onboarding_draft`).
The web/mobile wizard then submits, prefilled from the confirmed draft, and
still carries the legal acceptance and the paid GSTIN/bank verification exactly
as today. The founder approves activation in the existing admin queue, now with
the interview beside the profile.

**What it never does.** It never verifies (GSTIN/Udyam/bank), never writes
`provider_profiles`, `provider_categories`, `packages` or
`provider_verifications`, never activates. The runtime writes only its own
tables (`onboarding_sessions`, `provider_capability_facts`, `wa_*`, the
ledgers). Free text never confirms: the decision is written only from an
inbound `wa_messages` row with `kind='button'` and payload `confirm:<runId>`,
bound to the parked draft run.

**Shape.** Steps are code (`packages/agent-core/src/onboarding/machine.ts`,
pure, 30 tests). The runtime (`apps/agent-runtime/src/agents/onboarding`)
loads the session, transcribes audio through the existing web STT route,
masks contact info, runs the machine, persists a guarded patch, sends the
replies and performs the action (draft / confirm / revise / cap hand-off).
Every turn is one `agent_runs` row: the start turn is the root, every later
turn a child (`parent_run_id`); only the draft turn spends budget.

---

## Enablement bootstrap (nothing runs until all are true)

1. Runtime deployed (`RUNTIME.md`) with `AGENT_ENABLED=true`, `DATABASE_URL`,
   `WHATSAPP_DRIVER` + credentials (stub logs, never sends) and
   `WA_MEDIA_BUCKET` (`wa-media`, private).
2. Web: `AGENT_ENABLED=true`, `AGENT_RUNTIME_URL` + `AGENT_RUNTIME_SECRET`,
   `SUPABASE_JWT_SECRET`, `NEXT_PUBLIC_WHATSAPP_NUMBER` (the wa.me link).
3. `/admin/agents`: `agents_enabled.onboarding = true`; the pilot providers'
   user ids in `cohort_user_ids`; `budget_run_paise_by_agent = { "onboarding": 1500 }`
   (₹15 per run; absent = the global `budget_run_paise`); optionally
   `onboarding_session_ttl_hours` (default 72, sliding on each answer).
4. The four templates below approved in en/hi/te.
5. **Delegated-path gate (once, on the first deploy):** the laptop rig drives the
   runtime turn function in-process with the provider's own session token, so three
   legs are recorded as **skips** — the HMAC token exchange (`AMC-Runtime` →
   run-bound JWT), the `agent.onboarding` pg-boss queue, and the WhatsApp webhook
   ingestion. Before any cohort, run one real interview on the deployed runtime
   against the deployed web app: grant → token mint → voice-parse under the Bearer →
   decision route under the Bearer → runtime resume (FOLLOWUPS S1.6).
6. **Live eval gate:** `pnpm --filter @amclub/agent-core eval --set onboarding_interview`
   with an LLM key must clear **≥ 85 %** with **5/5 injection** cases passing.
   As of the S1.6 PR it has run in **stub mode only** (24/24, 5/5); the live
   score is **not yet recorded** — do not enable a cohort until it is.

**Turning it off:** `agents_enabled.onboarding=false` (or the kill switch, or
`AGENT_ENABLED=false` on either side). Inbound WhatsApp falls back to the S0.5
behaviour (keywords + holding reply); the wizard, `/profile/provider` and the
admin queue are byte-identical; existing sessions stay readable.

## The interview script

| step | prompt (copy id, `packages/shared/src/onboarding-copy.ts`) | accepts | on bad input |
|---|---|---|---|
| `language` | `welcome` [name] + `ask_language` with buttons `lang:en` / `lang:hi` / `lang:te` | button, or typed English/हिंदी/తెలుగు/1/2/3 | re-send the buttons |
| `business_name` | `ask_business_name` | text or voice note, 2..100 chars | `bad_business_name` |
| `gstin` | `ask_gstin` | 15-char GSTIN (format only; `gstinSchema`) | `bad_gstin`, state unchanged |
| `udyam` | `ask_udyam` + button `udyam:skip` | `UDYAM-XX-00-0000000` or Skip | `bad_udyam` |
| `categories` | `ask_categories` as a list (`cat:<slug>` rows, `cat:done` once one is picked) | up to 3, one at a time; typed number/name works | `categories_need_one` on an empty Done |
| `capabilities` | `ask_capability` [category, n/total, question] — 3 per category (`CAPABILITY_QUESTIONS`) | text or voice note ≥ 3 chars | `answer_too_short`; failed STT → `voice_failed_type_instead` |
| `photos` | `ask_photos` + buttons `photos:skip` / `photos:done` | images (≤ 5; `wa-media` paths), Skip/Done | re-prompt |
| `drafting` | `drafting_wait` → the ONE model call → summary (`renderDraftSummary`, ≤ 1024 chars/message) + buttons `confirm:<runId>` / `revise:<runId>` | — | budget/gateway error → `failed` + `failed_continue_web` |
| `review` | — | `confirm:<runId>` → decision; `revise:<runId>` → `revise_ask`, next message is the note → second draft; a revise after two drafts → `revise_cap` hand-off | free text → `review_buttons_reminder` + buttons |
| `confirmed` → `handed_off` | `handoff` with `${APP}/partner/onboarding?session=<id>` | — | — |

State machine (`ONBOARDING_TRANSITIONS`, `nextOnboardingStep`):

```
language → business_name → gstin → udyam ─(answered|skipped)→ categories → capabilities → photos ─(answered|skipped)→ drafting → review
review ─confirm→ confirmed → handed_off            review ─revise→ drafting (max 2 drafts)     review ─cap→ handed_off (no confirmation)
any active step ─expire→ abandoned                 any active step ─error→ failed             confirmed never goes back
```

Every stored answer passes `redactContactInfo` (flag `redacted`). Sessions
slide their `expires_at` on each answer; the expiry job abandons a session
past it and sends `onboarding_expired`.

## Templates to get approved (× en, hi, te)

| kind | names | param |
|---|---|---|
| `onboarding_start` | `amc_onboarding_start_{en,hi,te}` | `{{1}}` name |
| `onboarding_resume` | `amc_onboarding_resume_{en,hi,te}` | `{{1}}` step label |
| `onboarding_draft_ready` | `amc_onboarding_draft_ready_{en,hi,te}` | `{{1}}` display name |
| `onboarding_expired` | `amc_onboarding_expired_{en,hi,te}` | `{{1}}` link |

All four need the provider's WhatsApp grant (not in `WA_ALWAYS_ALLOWED_KINDS`).
Inside the 24 h window the runtime sends text and interactive buttons
(≤ 3 buttons; 4..10 as a list) instead.

## Dispatcher order (runtime `whatsapp/inbound.ts`)

**STOP** (opt-out always wins) → **active session** (`wa_conversations.active_session_id`
routes every other message into the interview — a typed "yes"/"ok"/"hi" is an
answer, not an opt-in, while a session is active) → **START/YES/…** (opt-in) →
**JOIN** (with a grant and the agent enabled: attach the user's web-started
session or create one, enqueue `start`; without a grant JOIN keeps its S0.5
opt-in meaning) → holding reply. Without an active session the S0.5 order is
unchanged.

## Confirmation rule

The button payload `confirm:<runId>` must name the session's current
`draft_run_id`. The runtime POSTs `/api/v1/agent/runs/<runId>/decision`
(`approve:true, final: draft, input_refs: { session_id, wa_message_id }`)
under the provider's delegated token; the web route writes the one
`ai_decisions` row and pings the runtime resume; the runtime verifies the row
(`hasApprovedDecision`), resumes the parked run in-process if the ping did not
reach it (guarded transitions make this idempotent), writes
`provider_capability_facts` (one per scope/deliverable line, provenance =
that decision), marks `confirmed` then `handed_off`. A replayed tap on a
terminal session is refused (`session_terminal`), and a typed "yes" only
re-sends the buttons.

## Founder review flow

`/admin/providers/[id]` gains an **Onboarding interview** section (when
`AGENT_ENABLED`): state, locale, redacted answers, transcribed voice notes,
signed photos (15 min), the draft and its decision id. Approve/reject are the
existing actions — the interview is context, never a decision.

## Metrics (PostHog, DESIGN.md Appendix A)

`onboarding_wa_started` → `onboarding_wa_drafted` → `onboarding_wa_confirmed`
→ `onboarding_wa_handed_off` → `onboarding_prefill_used` (wizard submit with
the session id) → activation (existing admin event). Also
`onboarding_wa_step {step, kind, outcome}`, `onboarding_wa_revised`,
`onboarding_wa_abandoned`, `onboarding_wa_failed`. Derived: median minutes
start→confirmed, revise rate, abandon rate, cost per confirmed draft
(`agent_runs.cost_est_paise` summed per session root).

## Rollback

Flag off → S0.5 behaviour; sessions stay readable; nothing in
`provider_profiles` was ever written by the agent. Migration **0036** is
additive; to drop: `ALTER TABLE wa_conversations DROP COLUMN active_session_id;
DROP TABLE provider_capability_facts; DROP TABLE onboarding_sessions;`
(revert the code with it — the dispatcher selects `active_session_id`).

## Prompt

`onboarding_interview@v1` (`packages/agent-core/src/prompts/onboarding_interview/v1.md`,
reasoning tier, output `onboardingDraftSchema` — strict at every level, no
status/verified/approved/rating keys, money null unless stated). Trusted:
locale, categories, the listing template, the answer map, the Zod-cleaned
business name and the state from the GSTIN. Untrusted: every answer and
revise note as an Envelope (`onboarding_answer`, id = the `wa_messages` row);
an unclean business name goes untrusted too (`onboarding_business_name`).
Golden set `golden/onboarding_interview.json`: 24 transcripts (7 en, 7 hi,
7 te; 8 categories; 5 injection).

## Known limits (FOLLOWUPS S1.6)

No TTS (questions are text; S1.8). STT still via the web route with a nominal
`duration_ms` (agent-core STT in S1.8). Photos stay in `wa-media`. No mobile
wizard exists yet. Interakt has no interactive buttons wired (numbered text
fallback; confirm needs Meta).
