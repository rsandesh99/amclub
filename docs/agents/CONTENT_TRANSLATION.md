# CONTENT_TRANSLATION.md — provider content translation (E14 N32b)

> Built dark. Three locks: `AGENT_ENABLED` + `agents_enabled.content_translate` + the cohort (`cohort_user_ids`).
> With any lock off, `/partner/translations` and `/api/v1/partner/translations/*` are a real 404 and nothing else
> changes. PRD: `docs/prd/PRD_EXPERIENCE_V3.md` E14 FR-14.3.

## What it is

A provider can show buyers their own catalogue copy in Hindi, Telugu and Tamil:

| Field | Where it lives | Where buyers see it |
|---|---|---|
| Package title | `packages.title_i18n[hi|te|ta]` | Package page `<h1>` (labelled); package cards (the text only: a card is a link) |
| "Choose this if…" | `packages.ideal_for_i18n[hi|te|ta]` | The tier buy box line (labelled) |
| About | `provider_profiles.about_i18n[hi|te|ta]` (English stays `about`) | Provider page About (labelled) |

Buyers reading in that language see the translation with **Translated · View original**; a tap shows the English
(`translation_viewed_original`).

## The flow

1. **Draft** (`POST /api/v1/partner/translations/draft` `{ subjectKind, subjectId?, lang }`, from Listings →
   **Translate your listings**). One bounded call per field: `provider_content_translate@v1` (task class
   `content_translate`, tier routine, residency **in** — it is the provider's own words). The English is untrusted
   (enveloped, kind `provider_content_<field>`, cap 1500). One `ai_invocations` row per call. Rate limit: the
   quote-extract burst budget per provider.
2. **Code decides what may become a draft**: the strict schema + `customerFacingText` (no contact details, no
   off-platform payment, no link), `contentNumbersProblems` (the translation carries exactly the source's digit runs,
   Latin digits only — numbers are copied, never translated), the field's length cap, and — for a real model output —
   the target script. Anything else: no draft for that field (`skipped`). Drafts go to `content_translations`
   (status `draft`, one open draft per subject / field / language). **A draft never renders.**
3. **Approve** (`POST …/[id]/approve` `{ text? }`, side by side on `/partner/translations`). The provider may edit
   first. The route claims the draft (`draft → approved`, so a double tap cannot write twice), re-checks the English is
   unchanged (else `409 source_changed`, draft `stale`), re-runs the numbers / length / contract checks on the final text
   (else `422 text_rejected`), writes the slot and `i18n_sources.<field>.<lang> = 'machine_approved'`, and records
   **exactly one** `ai_decisions` row (feature `content_translation`, proposed = the draft, final = the approved text).
   Then the catalogue pages revalidate.
4. **Discard** (`POST …/[id]/reject`): the draft is marked `rejected`; nothing is written.

Every route: agent gate (404) → session (401) → never a delegated agent token (`requireNotDelegated`) → the caller's
provider profile (403) → the agent on for this user (404).

## Data

Migration **0061**: `content_translations` (provider reads own; service role writes), `packages.i18n_sources`,
`provider_profiles.about_i18n` + `i18n_sources` (public like `about`; `rls/policies.sql` carries the grant),
`ai_decisions_feature_check` + `content_translation`. Buyer-side readers of the new columns are separate,
error-tolerant queries, so the code is safe to ship before 0061 is applied.

## Checks

- `pnpm --filter @amclub/agent-core eval --set provider_content_translate` — 13 golden cases (5 clean translations,
  8 planted bad outputs refused: numbers in words, native digits, an added number, a phone number, a link, a UPI id, the
  wrong script, too long). Live threshold 90 %, zero violations.
- `eval --set injection` — the 17 provider-text (`quote_text`) red-team cases also target this prompt.
- CI (`verify-experience` e14c): the surface is dark (404); an approved te title renders labelled; ta / About drafts
  never render.
- Flag-on server: `pnpm --filter @amclub/web trust:verify:content-translation` — drafts per field, nothing visible,
  another provider locked out, a changed number refused, approve writes the slot + one decision row, a second approve
  409, an English change makes the draft stale.

## Turning it on

1. Apply 0061. 2. Run the eval live (key present) — ≥ 90 % and zero violations. 3. Add the pilot providers to
`cohort_user_ids`, set `agents_enabled.content_translate = true`, `AGENT_ENABLED=true`. Review a sample of approved
texts with a native speaker (docs/i18n/REVIEW.md) before widening.

Events: `content_translation_drafted { lang, kind }` (client), `content_translation_approved { lang, edited }` (client +
server), `translation_viewed_original` (client).
