# Language review — te / ta on the buying path (E14)

PRD: `docs/prd/PRD_EXPERIENCE_V3.md` E14 (FR-14.1 N32, FR-14.2, FR-14.4 D-PRD7, FR-14.6).

## The rule

Machine drafts may be the input; a native speaker approves. Nothing a model
drafted reaches a Telugu or Tamil reader until it is either promoted by a
reviewer or switched on deliberately with the flag.

## Where the copy lives

| File | What it is | Renders |
|---|---|---|
| `apps/web/messages/<locale>.json` | Live copy | Always (English fallback key by key) |
| `apps/web/messages/drafts/<locale>.json` | Machine drafts awaiting review — buying-path namespaces only | Only while `EXP_V3_LOCALES=on`, and only for the namespaces in `EXP_V3_LOCALES_NAMESPACES` (comma list; unset = all buying-path namespaces). Live copy always wins over a draft. The flag honours `on` only (message files load without a user). |
| `apps/web/messages/drafts/REVIEW_LOG.json` | One line per promotion: locale, namespace, key count, reviewer, date | — |
| `apps/web/i18n/coverage.config.json` | The ONE list of gated namespaces (key `buyingPath`): the buying path (incl. `notify`, the notification copy built by `lib/i18n/notify.ts`) and, since the 2026-09-25 QA pass (F4), every other buyer, provider and public namespace. Internal admin namespaces (`admin`, `admin_*`, `trust_admin`, `dev_ui`) stay English and are not listed | — |

## The gate (CI)

`pnpm --filter @amclub/web i18n:coverage` (step "Language coverage" in `ci.yml`) fails when:

- a buying-path key in `en.json` is in neither the live file nor the drafts, for te or ta — so a new English key on the buying path ships with its te / ta drafts;
- a te / ta message does not parse, or its argument names or tags differ from English (a broken placeholder is a runtime error); a plural rendered as a plain argument is allowed;
- a draft or buying-path live key no longer exists in English, or a draft sits outside the buying path, or a key is both live and drafted.

`--strict` counts drafts as missing: that is the launch gate for turning te / ta on without the flag (acceptance: 100 % for the buying path).

## Reviewing a namespace

1. Open the drafts for the namespace (`messages/drafts/te.json` → `checkout`, say) next to `en.json`. Edit any string in place.
2. Check it on screen: set `EXP_V3_LOCALES=on` and `EXP_V3_LOCALES_NAMESPACES=checkout` on a preview, open the screens in `/te/...`. `/admin/dev/ui` renders every v3 component in all four languages (locale links at the top; a long-label strip shows Tamil at its longest).
3. Promote: `pnpm --filter @amclub/web i18n:promote -- --locale te --ns checkout --reviewer "Name"`. That moves the namespace live (English key order) and logs the reviewer.
4. `pnpm --filter @amclub/web i18n:coverage` and commit both files.

Launch acceptance (E14): native speakers review screenshots of the 12 key screens in all four languages: services, a category page, a service page, a package page, checkout, requirement (new), compare, order workspace (buyer), order workspace (provider), orders list, invoices, and notifications.

## Choices for the reviewer (flagged by the drafting pass)

- **GST** is in Latin script in the drafts; one older live te string (`catalog.price_plus_gst`) writes జీఎస్టీ. Pick one.
- **Quote (ta):** the drafts use விலைப்புள்ளி throughout; older live ta strings also use மேற்கோள் on provider screens.
- **Dispute (ta):** drafts use சர்ச்சை; older live ta strings also use தகராறு.
- **Plurals:** `catalog.orders_done` moves "done" inside each plural branch in te and ta so the verb agrees; the argument is unchanged.
- **Category names** (migration 0060, `CATEGORIES` in shared) reuse the live gateway names; the te / ta descriptions are drafts and render once 0060 is applied — review them with the category pages.
- **Legal drafts** (`legal`, `legal_gate`, the consent lines in `auth` / `provider_signup`): machine drafts of the Terms, Privacy Policy, Refund Policy and Provider Addendum render while `EXP_V3_LOCALES` covers them; have counsel check them with the native reviewer, or drop `legal` from `EXP_V3_LOCALES_NAMESPACES` until then.
- **Hindi GST:** live `hi.json` writes GST / GSTIN in Latin script everywhere (as the invoices, the GST portal and the te / ta drafts do); the hi category descriptions (shared `CATEGORIES`, `categories.description_i18n`) still write जीएसटी.

## Numerals (D-PRD7)

Money, dates and counts use Latin digits in every locale with Indian grouping
(₹1,23,456): `numeralsTag(locale)` / `formatCount` in `packages/shared/src/i18n-text.ts`
(unit-tested for en / hi / te / ta). Words stay in the locale's script. The drafts
contain no Telugu or Tamil digits.

## Voice languages (FR-14.5)

The catalog mic answers a spoken query only in a language that is listed in
`agent_settings.voice_search_languages` **and** has a passing eval in
`agent_settings.voice_language_evals` (≥ 50 queries, WER ≤ 20 %, right
category ≥ 85 %, current eval version — shared `voice-languages.ts`).

1. Build a set: ≥ 50 real queries in the language (take the phrasing from F6's
   `search_queries` sample), recorded by a native speaker, as JSON lines:
   `{"audio": "te/001.webm", "duration_ms": 3200, "reference": "gst registration for my shop", "category": "company-registrations"}`.
   `reference` is the English the pipeline should produce.
2. Run it against the environment you will switch on, as a signed-in buyer:
   `pnpm --filter @amclub/web voice:eval -- --lang te --set evals/voice/te.jsonl --token <access token> --base <url> --record`.
   A pass or a fail is recorded; a keyless (stub) STT is never recorded.
3. Add the language to `voice_search_languages` at `/admin/agents`. A failing
   re-run switches it back off by itself.

## Legal texts wait for counsel (2026-09-25)

Machine drafts of the `legal` namespace (Terms, Privacy, Refund Policy, Provider Addendum) sit in
`apps/web/messages/drafts/pending-counsel/{te,ta}.legal.json`. Nothing reads that folder: the namespace is
deliberately left out of `apps/web/i18n/coverage.config.json`, so te / ta readers see the English documents
until counsel and a native reviewer approve a translation. To publish one, copy the reviewed `legal` object into
the live `messages/<locale>.json` (or into `messages/drafts/<locale>.json` and add `legal` to the coverage list).
