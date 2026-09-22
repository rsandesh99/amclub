# Voice RFQ v2 — one clarifying question + document / drawing intake (S1.8)

**Status:** shipped dark (2026-09-21). Flags: `AGENT_ENABLED` + `agent_settings.agents_enabled.rfq_clarify`
(the question) and `agents_enabled.document_intake` (photos, PDFs, drawings) + `cohort_user_ids`. Flag off:
`POST /api/v1/rfq/voice-parse` answers with exactly the Phase 8b key set, `POST /api/v1/rfq/document-extract`
404s, `eval:golden` runs the same parser. The one spine addition — RFQ attachment upload — is an ordinary
product feature (not flag-gated).

## What it does

Phase 8b turns a 30-second voice note into a prefilled RFQ form and never guesses (`uncertain: true`). v2:

1. **One clarifying question.** When the first parse is uncertain or a template-required field is missing,
   the buyer hears ONE question in their language (te / hi / ta / en, in that script), answers by voice or by
   typing, and the merged parse prefills the form. Never a second question.
2. **Document / drawing intake.** A photo of a notice or invoice, a text PDF, or a STEP / DXF drawing becomes
   prefill: facts as editable chips, the description appended, the category applied only when empty, the
   file attached to the request.

Everything is prefill. The buyer's Create tap on the ordinary `POST /api/v1/rfq` is the confirmation and writes
ONE `ai_decisions` row (feature `rfq_intake`, tool `clarify_rfq` or `extract_document`, `run_id` null).

## Decisions (taken; do not reopen)

- **One round, enforced server-side.** A request carrying `prior` never receives another `clarify`; at most one
  paid TTS per clip.
- **Drawings never touch a model.** STEP / DXF summaries are pure string parsers in `packages/shared/src/drawings`
  with pinned fixture counts. Cheap, exact, un-injectable.
- **PDFs are text-only.** `pdf-parse` (pure JS) extracts the text layer; a scanned PDF gets 422 `pdf_no_text`,
  the copy says "photograph the page instead", the attachment stays. No rasteriser on Vercel.
- **Attachment upload is spine.** `rfq-attachments` private bucket; the document route stores the file in the same
  call so the client never uploads twice.
- **The parser prompt moved, its behaviour did not.** `rfq_parse@v1` is the Phase 8b text (lead + rules
  byte-equal to a fixture constant; the three runtime lists — categories, specializations, states — travel in the
  trusted block because a registry file is static). `@v2` adds the PRIOR ROUND section and runs only on round two.

## The one rule — `needsClarification(parse, template)` (`packages/shared/src/intake-rules.ts`)

Priority **category > required template field > scope > state**:

| gap | fires when |
|---|---|
| `category` | `parse.uncertain` or no category (the Phase 8b clamp nulls the category whenever uncertain) |
| `<field>` | the first required template field (not a textarea) the English description does not cover — quantity-like fields need a digit, location-like a named Indian place, timeline-like a time word, budget-like money; select fields an option value; otherwise a name / label keyword |
| `scope` | the description is under 40 characters |
| `state` | no state and no Indian place named |

The question itself comes from `rfq_clarify@v1` (live tier, one bounded call) and must echo `gap` and `locale`;
on any failure (budget cap, gateway error, wrong echo) the fixed per-gap question `stubClarifyQuestion` is used —
the buyer is never blocked on the model. Target language = the STT `languageCode` mapped by `clarifyLocaleFor`
(te / hi / ta, else en).

## Round two (`prior`)

The client echoes `prior` = `{ transcript_english, parse, question }` (schema `voiceParsePriorSchema`) with EITHER
`audio` (STT as today) OR `answer_text` (no STT; `vendor.stt` = `typed`). The parser runs `rfq_parse@v2` with the
prior's **structured** fields, the question and the template's required field names in the trusted block; the
first transcript, the first description and the answer are Envelopes (`voice_transcript`, `prior_description`,
`clarify_answer` / `clarify_answer_text`). Merge rules: fill only what the answer addresses, never revert a field
the first parse had right, `uncertain: false` only when every required field is now covered. The reply's `parse`
is the merged one; it never carries `clarify`.

`voice_meta.clarify` (`{ question, gap, answer_transcript, answered_by: voice | text | skipped }`) travels with
the RFQ on Create; the question's extraction row id goes into `intake_extraction_ids` in every case (answered or
skipped), so the decision records that a question was shown.

## TTS (`clarify_tts_enabled`, default false — paid)

When on and `SARVAM_API_KEY` is set, the question is synthesised once (Sarvam bulbul, ≤ 20 s), logged as
`ai_invocations` step `tts` / task `text_to_speech` (feature `rfq_intake`), returned inline as `audio_data_url`
(≤ 400 KB, else null) and never stored. Keyless: the stub logs a `stub` row and returns null; the client shows the
question as text. Cost: one live-tier TTS call per clarified clip.

## Documents (`POST /api/v1/rfq/document-extract`)

`agentApiGate()` (404 while dark) → session → `isAgentEnabledForUser('document_intake')` (404 outside the cohort)
→ `limiters.documentExtract` 5/min + 30/h → the file is stored as an attachment → by type:

| type | path | model |
|---|---|---|
| image (jpg / png / webp) | `document_extract@v1` with the image labelled `doc` | frontier (vision) |
| PDF | `pdf-parse` text layer (≥ 40 chars, first 12 000) as an Envelope `document_text` → the same prompt; else 422 `pdf_no_text` | frontier |
| STEP / DXF | `parseStepSummary` / `parseDxfSummary` | **none** (`model` NULL) |

The masking clamp (`clampDocumentExtract`) runs on every model result: GSTIN (15) / PAN (10) / other long ids →
X's with the last 4 visible, phones and emails stripped (`redactContactInfo`), emptied facts dropped. The prompt
also asks the model to mask, and to report printed instruction-like text as one `note` fact — never to obey it.
Every result is one `rfq_intake_extractions` row (`proposed` = the validated result, `input_refs` = attachment
path, mime, size, mode; never the document text).

Drawing heuristics, stated: hole estimate = round(cylindrical surfaces / 2) for STEP (each cylindrical hole is
usually two half-cylinder faces; chamfers and fillets skew it), = circle count for DXF; bounding box = extents of
every CARTESIAN_POINT (STEP) / `$EXTMIN`–`$EXTMAX` (DXF); units from `LENGTH_UNIT` + `SI_UNIT` or
`CONVERSION_BASED_UNIT('INCH')` (STEP) / `$INSUNITS` (DXF), converted to mm. Binary DXF is refused.

## The Create tap (`POST /api/v1/rfq`)

`intake_extraction_ids` (≤ 4) are checked BEFORE the insert: every id exists, belongs to the caller and is unlinked
(422 `intake_not_found` / `intake_not_owned` / `intake_already_linked` / `intake_too_many`). After the insert:
`recordAiDecision` (feature `rfq_intake`; `input_refs { rfq_id, extraction_ids }`; `proposed` = per id kind +
result; `final` = title, detail keys, attachment count, `voice_meta.clarify` when present) and `rfq_id` +
`decision_id` on the rows. A linked row can never be reused. The S1.5 two-phase path runs after this, unchanged.

## Attachments (spine)

`POST /api/v1/rfq/attachments` (buyer session, ≤ 10 MB, allow-list images / PDF / STEP / DXF) stores
`rfq-attachments/<msmeId>/<uuid>.<ext>` and returns that reference; `rfqs.attachments[].url` holds it. The buyer's
and the matched providers' detail loaders (`getRfqForBuyer` / `getRfqForProvider`) resolve it to a 15-minute signed
URL; nobody else reaches those loaders. Legacy `http(s)` URLs pass through. **Ground-truth correction:** on this
tree the buyer / provider RFQ detail pages did not render `attachments[]` at all (the prompt assumed they did) —
they now list them as links (`docs/FOLLOWUPS.md`).

## Enablement bootstrap (nothing runs until all are true)

1. `AGENT_ENABLED=true` on the web deploy.
2. The private `rfq-attachments` bucket exists (`pnpm --filter @amclub/db exec tsx src/scripts/setup-storage.ts`,
   idempotent) and migration 0038 is applied.
3. `agent_settings.agents_enabled.rfq_clarify = true` and/or `agents_enabled.document_intake = true`.
4. The buyer's user id is in `agent_settings.cohort_user_ids`.
5. Optional: `agent_settings.clarify_tts_enabled = true` + `SARVAM_API_KEY` for spoken questions.
6. **Live eval gate before any cohort:** `pnpm --filter @amclub/agent-core eval -- --set rfq_clarify` and
   `--set document_extract` with a key must clear ≥ 85 % with every injection case passing; `eval:golden` must stay
   green with the moved parser.

## Rollback

Flags off → Phase 8b byte-identical (`voice-parse` key set unchanged, document route 404, no button rendered);
attachments stay readable (spine); `rfq_intake_extractions` rows stay (agent-owned telemetry). To drop the table:
`DROP TABLE rfq_intake_extractions;` and revert the code with it (the create route names it). The
`ai_decisions_feature_check` widening is harmless to keep.

## Metrics (PostHog, DESIGN.md Appendix A)

`voice_rfq_clarify_shown { gap, tts, locale }` → `voice_rfq_clarify_answered { by: voice | text | skipped, gap }`
(answered / skipped rate per gap); parse `uncertain` rate before vs after the round (from `voice_meta`);
`rfq_intake_document { kind, doc_type, mode, stub, facts }` / `rfq_intake_document_failed { reason }` (documents
per RFQ, failure reasons); `rfq_intake_chip_edited { k }` (edited-chip rate = extraction quality);
`rfq_intake_document_added` (client).

## Verified on this laptop (2026-09-21, pre-approval)

`voice:verify:v2` offline 5 pass + `eval:golden` SKIPPED (no LLM key); flag-off against a local production server on
the prod DB: 14 pass, 6 skips, 0 fail — the voice-parse key set is exactly Phase 8b's, the document route 404s,
bad type 422 / oversize 413, a foreign intake id 422 without an RFQ, the RFQ create + fan-out + stranger 404
unchanged. The **bucket-dependent checks are recorded skips until the gate creates `rfq-attachments`** (upload,
signed reads); the flag-on lifecycle runs after 0038 + the bucket. Recorded skips by design on this laptop: real
TTS audio (needs `SARVAM_API_KEY`), the 429 (rate limiting is disabled without Upstash), goods mode
(`MART_ENABLED` off on prod), live evals (no key).

## Known limits (FOLLOWUPS S1.8)

Scanned PDFs (rasterise in the runtime later); binary DXF unsupported; STEP bounding box counts every
CARTESIAN_POINT (axis placements included); `VOICE_PARSE_MODEL` kept through a per-call gateway override;
mobile has no file picker (clarify round only); the detail pages' attachment rendering was added here.
