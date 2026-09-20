# docs/agents — the agent programme

Start here before touching anything under the agent programme.

- **`ARCHITECTURE.md`** — the locked architecture. Required reading; its §7
  invariants checklist goes into every agent PR.
- **`../adr/008-agent-runtime-and-delegated-identity.md`** — why a second
  runtime and delegated identity (the topology decision).
- **`../adr/009-agent-programme-build-architecture.md`** — how the programme is
  built (packages, migrations, prompts, ledger, sequencing).
- **`../../BUILD_PROMPTS.md`** — the executable plan: one self-contained,
  gated prompt per PR, S0.1 → S4.3. Run in order; do not combine stages.

Per-agent runbooks land with their stages and live here:

| file | added by | covers |
|---|---|---|
| `RUNTIME.md` | S0.1 | deploy, secrets, rollback (scale to 0) |
| `WHATSAPP.md` | S0.5 | BSP/Meta setup, template list, testing |
| `QUOTE_EXTRACTION.md` | S1.1 | prompt id, golden set |
| `COMPARE_DECLINE.md` | S1.2 | flag table, normalisation, pointers + decline-message prompts, templates |
| `PAYOUT_DOSSIER.md` | S1.4 | how to read a dossier; what "hold" means |
| `ONBOARDING.md` | S1.6 | interview script, templates, founder review |
| `DISPUTE_TRIAGE.md` | S1.7 | triage card, evidence links |
| `VOICE_RFQ_V2.md` | S1.8 | one-round clarify, document/drawing intake |
| `SECURITY.md` | S2.1 | threat model, the red-team gate |
| `MUNSHI.md` | S2.2 | drafts, price book, voice approval |
| `SUPPORT.md` | S2.3 | intents, escalation, self-serve rate |
| `SCORE.md` | S2.4 | AMC Score v1 inputs and privacy |
| `PROCUREMENT.md` | S3.1 | buyer agent flow |
| `BENCHMARKS.md` | S3.2 | density gate, fair-price ranges |
| `AGGREGATION.md` | S3.4 | services pools, tiered quotes |

Founder-gated externals that enable (not build) stages live in
`docs/PRE_LAUNCH_CHECKLIST.md` Track 1 and `docs/COMPLIANCE.md`.
