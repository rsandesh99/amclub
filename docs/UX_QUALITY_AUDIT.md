# UX quality audit — how a serious team would run this, what to change, and every QoL gap

**Date:** 2026-09-22 · **Companion to:** `docs/USER_EXPECTATIONS_AUDIT.md` (functional gaps, P0 defects).
**Method:** four read-only sweeps (design system & typography · forms & inputs · navigation, feedback &
flow · mobile & localisation), spot-verified. **✔** = re-read line by line; the rest carries file:line
evidence from the sweep and must be re-confirmed by the PR that fixes it. Scope additions still go
through DESIGN.md §8.1; most of this is conformance to specs you already wrote (`FRONTEND.md`,
`DESIGN.md` §4) that the code drifted from.

**Who we design for** (from DESIGN.md §1.4, restated because every decision below follows from it):
MSME owners and practitioners in Tier-2/3 clusters, often 40–60, on 2–4 GB Android phones with
patchy 4G, reading Hindi/Telugu/Tamil/English, some low-literacy, in sunlight, between other work.

---

## Part A — Operating model: how a capable organisation manages UX quality

The defects below are not random; they are what happens when quality depends on each PR author
remembering everything. A serious team makes quality **structural** — encoded in tools, gates and
rituals so it can't silently regress.

### A1. Ownership
| Role | Owns | Here, at founder scale |
|---|---|---|
| Journey owner (buyer / provider / ops) | End-to-end task success for that persona; the journey script; the metric | Founder hat per journey; one written script each (A4) |
| Design-system owner | Tokens, components, lint rules, Storybook, visual regression | One engineer-week to set up, then a rotation |
| Localisation lead + native reviewers | Glossary per language, translation QA, pseudo-locale, cultural review | Paid native reviewers for hi/te/ta (per-string contract), glossary in repo |
| Quality/QA | Device lab, release bug-bash, severity triage | Two real low-end Androids (e.g. 3 GB RAM, 720p) + BrowserStack |
| Research | Field sessions, support-ticket taxonomy | 5 users per round, in one cluster, every 2–3 weeks |

### A2. Definition of Done for every user-visible PR (paste into the PR template)
- [ ] Every string through next-intl / mobile i18n, **present in every locale we route** (or the
      surface is hidden for that locale); plurals via ICU; no string concatenation.
- [ ] Verified at **320 px and 360 px**, and at **Android "Largest" font / 200 % browser zoom**.
- [ ] Loading, empty, error (with retry) and offline states designed; success confirmed (toast or
      banner) naming **who acts next**.
- [ ] Irreversible / money-moving actions use `ConfirmSheet` showing the **server-computed
      consequence** (A-arch §7).
- [ ] Forms: labels (not placeholders), per-field translated errors, focus to first error, draft
      survives refresh/back, submit shows pending and can't double-fire.
- [ ] Touch targets ≥ 48 dp, text ≥ 15 px (13 px floor for metadata), contrast ≥ 7:1 body per
      FRONTEND.md §8.
- [ ] Page `<title>` set; back affordance on detail pages; deep link lands on the right section.
- [ ] axe clean; keyboard path works; screen-reader labels translated.
- [ ] PostHog event(s) per DESIGN.md Appendix A; any new notification has copy in every locale.

### A3. Automated gates (so the checklist enforces itself)
| Gate | Catches | Tooling |
|---|---|---|
| Lint: no arbitrary `text-[<14px]`, no raw `<select>`, no `window.confirm`, no JSX string literals / English `aria-label`/`placeholder`, no `toLocale*String` outside `format.ts` | T2, forms, l10n drift | ESLint custom rules + `eslint-plugin-i18next`-style literal check |
| i18n coverage report per namespace per locale; fail CI if a *routed* locale is missing a key in a shipped namespace | te/ta half-English screens | small script over `messages/*.json` |
| Pseudo-locale build (`xx`: +40 % length, accented, tall glyphs) in visual tests | overflow, clipping | next-intl custom locale |
| Visual regression: key screens × {320, 360, 1280} × {en, hi, te} × {100 %, 200 % font} | layout breaks, drift | Playwright screenshots (Chromium already installed), per-PR diff |
| axe on authenticated pages in CI (today public/auth only — A11Y.md) | a11y regressions | existing `a11y-scan.ts` against a seeded preview |
| Perf budget on a throttled "Moto G" profile: JS per route, LCP < 2.5 s, CLS < 0.1 | slow first loads | Lighthouse CI on the Vercel preview |
| API contract test: every non-2xx response has `{ code }` from the shared catalogue | raw English errors | unit test over route handlers |

### A4. Research & feedback loop
- **Journey scripts** (buyer: "post an RFQ by voice → compare → pay → submit requirements → accept";
  provider: "join → first quote → deliver → get paid"; ops: "resolve a dispute") — run them on the
  real devices every release; time-on-task and error count are the metric.
- **Field sessions** in one cluster per round (5 users is enough to find 80 % of issues); record
  with consent; translate findings into backlog items with severity.
- **Instrumentation:** PostHog funnels per journey step; session replay with input masking **on**
  (contact/KYC/money fields); rage-click and dead-click reports.
- **Support taxonomy:** every support/grievance contact tagged (screen + cause); the top 5 tags feed
  each planning cycle.

### A5. Release discipline
Feature flags per surface (already the rule), cohort rollout, a 30-minute **bug bash** before each
cohort widening, severity SLAs (S1: 24 h, S2: next release), and a public changelog for providers.

### A6. One source of truth for UX specs
`DESIGN.md` §4 says body 15 px; `FRONTEND.md` §2.4 says 17/26; `tailwind.config.ts:94-101` quotes 17/26
in a comment and ships 15 ✔. Pick one (recommend FRONTEND.md, 16–17 px), record it in an ADR, delete
the other statement.

---

## Part B — Architectural changes (the few that remove whole classes of defects)

| # | Change | Kills | Notes |
|---|---|---|---|
| 1 | **`nextActionFor(role, entity, status)` in `packages/shared`** — derived from the existing state machines: who is waiting, what the next action is, the deadline, and the copy key. | No to-do queue, no badges, no "waiting on you/provider", silent clocks, stepper copy, notification CTAs — all computed separately today or not at all | One pure function feeds dashboard to-do lists, nav badges, order stepper, notification text and mobile. The action map already half-exists in `OrderWorkspace.tsx:29-44 actionsFor()`. |
| 2 | **Error-code contract**: every API error is `{ code, fields?: { path: code } }` from a shared catalogue; clients map to `errors.*` messages; Zod issues map to field codes | ~256 raw English API errors shown to users; generic "save failed"; errors not on fields | The pattern exists in Mart (`errKey()` in `PoolJoin.tsx:75`, mobile `errorCode` in `lib/api.ts:678`) — generalise it. |
| 3 | **Form system**: `FormField` (label, required/optional, helper, linked + announced error), `useDraft` (per-user autosave, expiry, unsaved-changes guard), server-error→field mapper, and **domain inputs** backed by shared parsers (see Part D) | Every form finding in §C3 | Parsers/formatters live in `packages/shared` so web + mobile behave identically (phone normalise, GSTIN→state/PAN, pincode, paise). |
| 4 | **Locale architecture**: account `preferred_locale` is the source of truth (saved on every switch, read by mobile on boot, used by notifications); locale-aware `formatDate/Relative/Money/Words(lakh/crore)` in shared; ICU plurals on mobile; translatable reference data (36 states, categories in te/ta); `'simple'` FTS + synonym table + pg_trgm | te/ta forced to English, English dates, "1 products", GST≠जीएसटी in search, wrong-language WhatsApp | Also fixes the MsmeWizard override (`MsmeWizard.tsx:74-77`). |
| 5 | **Role-aware app shell**: bottom tabs (mobile) / top nav (desktop) per role with badges from #1, Buying/Selling switch, shared `PageHeader` with back + title | No primary nav ✔ (`AppShell.tsx:40-58` has only logo, language, bell, account), no back on detail pages, 60/76 untitled pages | Nav map in §C5. |
| 6 | **Shared design tokens package** consumed by web Tailwind and mobile NativeWind (type scale, colours, radii, spacing, `:lang()` typography) | Web/mobile drift, stale CSS vars (`globals.css:18-24`), mobile never applying loaded fonts | Tokens as TS → generate `tailwind.config` fragments for both apps. |
| 7 | **Consequence previews for money/irreversible actions**: server endpoint returns what an action will do ("releases ₹4,720 to Sharma & Co", "refund ₹3,000 of ₹5,000 by 27 Sep", "3 other quotes will close"); `ConfirmSheet` renders it | One-tap quote accept charging money, one-tap accept-delivery releasing escrow, one-tap cancel, admin refund/release with no confirm | Keeps the "money is server-computed only" rule (FRONTEND.md §8) — the client never computes the amount it shows. |
| 8 | **Typed deep-link builder** in shared (`linkFor(entity, id, section)`) used by notifications, emails, WhatsApp and the mobile router | Notifications to the wrong role's route, lists instead of the RFQ, mobile links falling back to Home | Replace string paths in `fanout.ts:68`, `finalize.ts:112`, `goods-fanout.ts:48`, `quotes/[quoteId]/messages/route.ts:116`, mobile `notifications.tsx:88-95`. |
| 9 | **Mobile navigation & data layer**: a Stack per tab (detail routes out of hidden `Tabs.Screen`), TanStack Query with persisted cache + NetInfo offline banner, FlatList/FlashList with `nextOffset` paging, `expo-image` | Android back → Home, no pull-to-refresh, no offline, whole lists in ScrollView, uncached images | `apps/mobile/app/(app)/_layout.tsx:112-128`. The stack table (CLAUDE.md) already names TanStack Query. |

---

## Part C — Findings (ranked within each layer)

Severity: **S1** blocks a flow / breaks trust or money · **S2** major friction · **S3** polish.

### C1. Foundations — type, colour, touch, motion
| Sev | Finding | Evidence | Fix |
|---|---|---|---|
| S1 | Body text is 15 px; `text-sm` = `text-base` = 15 px; 17 px token used 19× vs `text-sm` 587× / `text-xs` 422× | `tailwind.config.ts:99-101` ✔ | `sm`/`base` → 16–17 px, line-height 1.6; `xs` only for non-essential metadata |
| S1 | **No Indic typography rules**: no `:lang()` in CSS; headings 1.04–1.3 line-height with negative tracking; `leading-none/tight/snug` ×21 | `app/globals.css` ✔; `tailwind.config.ts:103-108` ✔ | `:lang(hi,te,ta){line-height:1.7;letter-spacing:0}`, headings ≥ 1.4, +1 px for te/ta |
| S1 | 101 arbitrary sizes, many 10–11.5 px, concentrated on the **decision screen** (quote compare: flags 11 px, verified badge 10 px, revision chip 10 px, uppercase headers 11 px), product card MOQ/HSN 11 px, voice consent 11.5 px, unread count 10 px | `QuoteCompare.tsx:177,228,238,301`; `ProductCard.tsx:48`; `VoiceRfqRecorder.tsx:233`; `NotificationBell.tsx:40` | Lint ban < 14 px; 13 px floor for chips, 15 px for numbers/legal |
| S2 | Weight 500 used 242× (every Button, Badge, Label) but only 400/600/700 loaded → renders as regular | `app/[locale]/layout.tsx:34-40`; `ui/button.tsx:29` | Load 500 or switch to semibold |
| S2 | Secondary text `#5C645C` ≈ 5.9:1 — below the 7:1 floor in FRONTEND.md §8, and it's the colour of most tiny text | tokens | Darken to ≈ `#4A514A` |
| S2 | Stars: amber-500 / gray-300 on white ≈ 2.1:1 / 1.5:1, colour-only, English "N star" labels, 14 px | `ReviewSection.tsx:25`; `catalog/Stars.tsx:19` | Shape difference, ≥ 3:1, numeric value, translated label |
| S2 | Disabled = 50 % opacity; no reason shown | `ui/button.tsx:32`; `globals.css:108,117` | Muted-fill disabled style + helper text saying what's missing |
| S2 | 27 all-caps labels (spec bans them; meaningless in Indic scripts) | `QuoteCompare.tsx:301,407`; `QuoteTermsRow.tsx:30`; `IntroDoors.tsx:38` | Remove |
| S2 | Touch-target escapes from the global 44 px rule: `<select>` (36–40 px, sort ≈ 30 px), consent checkbox 16 px, attachment "remove" text links, `<summary>` chip ≈ 18 px; MunshiPanel uses a non-existent `field` class (raw controls) | `DeclineRfqButton.tsx:46`; `QuoteComposer.tsx:222`; `QuoteCompare.tsx:238,282`; `ConsentCheckbox.tsx:27`; `RfqForm.tsx:374`; `MunshiPanel.tsx:286-292` | Global min-height for `select,input,summary`; 24 px checkbox; icon buttons with labels; target 48 dp (FRONTEND.md) |
| S3 | Stale CSS vars (pre-contrast-fix colours) still referenced; `rounded-input` class undefined | `globals.css:18-24`; `RevealResults.tsx:170`; `DossierPanel.tsx:292` | Sync vars with Tailwind; add radius |
| S3 | Status badges colour-only; status→colour map duplicated ×3 | `OrderWorkspace.tsx:22`; `GoodsOrderWorkspace.tsx:24`; `partner/listings/page.tsx:12` | One `StatusBadge` with icon |
| S3 | No `color-scheme: light` → Android force-dark can invert unpredictably | `globals.css` | Declare it |
| S3 | Grey skeleton pulse ignores reduced-motion; two gateway bounce easings contradict "no bounce" | `CardSkeleton.tsx:7-19`; `globals.css:158,161` vs `:44` | `motion-safe:` |

### C2. Component library
Exists (hand-built): badge, button, card, input, label, progress, native select, textarea, toast.
No Radix/cmdk/sonner/vaul. **Missing**, each with the defects it would absorb:

| Component | Absorbs |
|---|---|
| `ConfirmSheet` / `Dialog` (translatable, Escape, focus trap) | one-tap money actions; `window.confirm` in `ListingActions.tsx:31`; 3 hand-rolled dialogs |
| `SearchableSelect` / `Combobox` (bottom-sheet on mobile) | 36 English-only states in 9+ forms; categories; HSN; cities |
| `DateInput` (IST-safe, no past dates where invalid) | 9 native date inputs; coupon/CMS UTC day-shift (`CouponsClient.tsx:21,54`, `cms/page.tsx:74-75`) |
| `MoneyInput` (₹ prefix, 1,00,000 grouping, emits paise) / `PercentInput` (shows %, stores bps) | bare number boxes; bps-vs-% 100× trap between `MartSettingsClient.tsx:132` and `categories/page.tsx:64` |
| `Tabs`, `Pagination`, `Stepper` | unfiltered unpaginated lists; "42 %" progress instead of "Step 2 of 4" (`ui/progress.tsx:17-19`) |
| `FileDropzone` / `CaptureOrPick` | camera forced on PDF pickers (`IntakeDocumentButton.tsx:77`, `CatalogWizard.tsx:260`); no progress/preview/remove |
| `Tooltip` → replaced by tap-to-expand `InfoRow` | hover-only explanations on the quote screen (`QuoteCompare.tsx:177,201,258`) |
| Toast fixes | 4.5 s auto-dismiss, errors `polite` not `assertive`, English "Dismiss", overlaps sticky bars (`ui/toast.tsx:27,62,63,78`) |
| `Card` variants, `ButtonLink` | 114 hand-written card class strings vs 4 `<Card>`; 13 links styled as buttons; stray radii |

### C3. Forms & inputs
**Cross-cutting (S1):** errors aren't associated with fields (`ui/input.tsx:14-24` — no `id`,
no `aria-describedby`), most forms show one bottom message, server `error.flatten()` is ignored by
clients (→ "save failed"), Zod messages English-only (`shared/schemas/index.ts:38-87`), no
`beforeunload` anywhere, no OTP autofill anywhere.

| Sev | Form | Finding | Evidence |
|---|---|---|---|
| S1 | Login | **Pasted `+91 98765 43210` becomes `9198765432`** (strip then keep first 10) — valid-looking wrong number; the `+91` branch is dead code | `components/auth/PhoneStep.tsx:74` ✔, `:43` |
| S1 | OTP (web) | Six fixed 48 px boxes + gaps = 328 px → **overflows at 320–390 px** inside card padding; no `autocomplete="one-time-code"`; paste only exact 6; multi-char keeps last; auto-submit can double-fire; English aria-labels | `OtpStep.tsx:115,126` ✔, `:47,52,66,125` |
| S1 | OTP (mobile) | No SMS autofill, **no resend**, no auto-submit | `mobile/app/(auth)/login.tsx:131-134`; `signup.tsx:166` |
| S1 | MSME signup/profile | Language options en/hi only; saving anything ≠ `hi` stores `en` → **te users silently switched to English** | `MsmeWizard.tsx:76,184-185`; `MsmeProfileForm.tsx:61,88-89` |
| S1 | Provider wizard | Restored draft keeps `bankVerified` with blanked account → submits with no account, fails at the end | `ProviderWizard.tsx:172,242,895` |
| S1 | Package editor | Typed scope item without "Add" is **lost** on Continue, then "add at least one" | `ListBuilder.tsx:20`; `PackageWizard.tsx:73` |
| S1 | Goods checkout | State defaults to `AP`; GST preview doesn't refresh on state change → wrong IGST/CGST split; Pay disabled with no reason; phone has no +91 handling | `GoodsCheckoutClient.tsx:59,75,124,189` |
| S2 | GSTIN everywhere | Uppercased but no length/live checksum (`isValidGstin` unused in MSME forms); state not derived from GSTIN digits 1-2; PAN re-typed though it's chars 3-12; verified GSTIN can't be changed | `MsmeWizard.tsx:263-272`; `ProviderWizard.tsx:604,691,697,714` |
| S2 | Bank step | English placeholders; no digit filter; no confirm-account; no IFSC lookup | `ProviderWizard.tsx:816-824` |
| S2 | RFQ form | Budget label not linked, placeholders-as-labels, no grouping, no min ≤ max; past dates allowed; template options untranslated; category change wipes answers silently; title min shown only on submit | `RfqForm.tsx:242,427,455,460,479-489` |
| S2 | Quote composer | No draft; goods quote has no running total (qty × unit + GST); scope min hidden; past valid-until | `QuoteComposer.tsx:174,305-333,345,371` |
| S2 | Checkout (services) | GSTIN not uppercased / prefilled; coupon unlabeled; raw server errors; new idempotency key every tap | `CheckoutClient.tsx:85,92,102,159,175` |
| S2 | Review / dispute | Placeholder-only labels; English star labels; dispute can't upload new evidence; min-length hint appears late; no draft | `ReviewSection.tsx:24,116`; `DisputeStatementCard.tsx:68,79-80` |
| S2 | Admin | Refund/Release one click; partial refund unbounded; coupon/CMS dates shift by IST offset; raw setting keys / JSON textareas | `admin/disputes/[id]/page.tsx:171-177`; `MartSettingsClient.tsx:178-212` |
| S2 | Gateway | Only 10 states, no "Other" → most of India skips and loses prefill | `gateway/draft.ts:18` |
| S3 | Misc | Country of origin as 2-letter code; HSN free text; pincode never asked in MSME profile | `CatalogWizard.tsx:298,309`; schema has it (`shared/schemas/index.ts:85`) |

What's already good (keep the pattern): gateway wizard (tap cards, back, skip, "Step n of 4",
survives locale switch), RFQ autosave + restore notice, ProviderWizard GSTIN checksum before the paid
verify call, voice + document intake chips.

### C4. Feedback, status & destructive actions
| Sev | Finding | Evidence |
|---|---|---|
| S1 | **Quote accept = one tap straight to checkout**; no total, no escrow explanation, no "other quotes close" | `QuoteCompare.tsx:140-158,201-202` ✔ |
| S1 | Accept delivery (releases escrow), cancel, request revision (no reason field), provider accept/deliver — all fire immediately | `OrderWorkspace.tsx:143-161,226-230` |
| S1 | Order status = badge + past-event log; **no stepper, no "waiting on you/provider", no deadlines** (24 h accept, delivery ETA, 72 h auto-accept); unknown events render as `event.replace(/_/g,' ')` | `OrderWorkspace.tsx:186-205,273-298,283` |
| S2 | Toast system exists but core flows don't use it (only 16 files, all admin/agent/mart); order/quote/RFQ/listing actions end in bare `router.refresh()` | `OrderWorkspace.tsx:143-161`; `QuoteComposer.tsx:207`; `DeclineRfqButton.tsx:33`; `ListingActions.tsx:25-35` |
| S2 | Silent/raw failures: listing delete ignores response; quote accept shows `'failed'`; notification load error looks like "all caught up" | `ListingActions.tsx:31-35`; `QuoteCompare.tsx:145,156`; `NotificationCenter.tsx:29` |
| S2 | No "payment received and held" moment for services (`?first=1` ignored); no "sent to N providers" after posting an RFQ | `OrderWorkspace.tsx:94`; `RfqForm.tsx:298` |
| S2 | 13 `loading.tsx` for 76 pages, one generic skeleton; "Loading…" text in client lists | `shell/RouteSkeleton.tsx`; `NotificationCenter.tsx:69` |
| S2 | No `error.tsx` in `(mart-*)`/`(agent-*)`, no `global-error.tsx`; "Try again" is `reset()` only; "Go home" → `/` | `RouteError.tsx:280-288` |
| S2 | 404 drops the app shell and offers only "Go home"/"Browse" | `[locale]/not-found.tsx` |
| S2 | RFQ pages don't show "quotes close in 2 days" (`expiresAt` computed, unused); provider inbox rows lack expiry/budget/location; raw field keys | `(msme)/app/rfq/[id]/page.tsx:43,72`; `partner/rfqs/page.tsx:32-42` |
| S3 | Empty states without CTA (provider orders, RFQ inbox, notifications) | `partner/orders/page.tsx:22`; `partner/rfqs/page.tsx:22-27` |

### C5. Navigation & information architecture
| Sev | Finding | Evidence |
|---|---|---|
| S1 | **No primary navigation for buyers/providers** — header is logo, jurisdiction (desktop), language, bell, account ✔; everything else is dashboard tiles | `components/shell/AppShell.tsx:40-58` ✔ |
| S1 | **No "needs your action" queue** on either dashboard | `(msme)/app/page.tsx`; `(provider)/partner/page.tsx:69-81` |
| S2 | Detail pages have no back/breadcrumb; deep links from WhatsApp have no history → Android back exits | orders/[id], rfq/[id], partner/*, checkout, invoices |
| S2 | Role switch buried in avatar menu; notifications mix buyer + provider items; tapping one silently switches shell | `AccountMenu.tsx:101-111`; `NotificationCenter.tsx:52` |
| S2 | 60 of 76 pages have no `<title>` (every tab reads "AMClub") | `[locale]/layout.tsx:99-102` |
| S2 | Public header nav hidden on phones with no replacement | `PublicHeader.tsx:30` |
| S2 | Language switcher on phones is a **transparent 24 px `<select>`**, current language invisible | `LanguageSwitcher.tsx:51-61` |
| S2 | Help only in the avatar menu; no "contact support about this order" (WhatsApp prefilled); grievance `mailto:` empty ✔ | `AccountMenu.tsx:120`; `help/page.tsx:75` ✔ |
| S3 | Admin logo → verifications, 14 wrapping tabs without counts; filters not written to URL | `AdminNav.tsx:7-35`; `admin/providers/page.tsx:19-22` |
| S3 | Bell polls every 30 s even in hidden tabs (prepaid data); no PWA install prompt; unsized `<img>` banner above tasks (CLS) | `NotificationBell.tsx:234`; `PwaManager.tsx`; `BannerSlot.tsx:35` |

**Proposed IA** (driven by Part B #1 and #5):
- **Buyer tabs:** Home (to-do first) · Requests (badge: new quotes + questions) · **Post** (centre) ·
  Orders (tabs: Needs action / Active / Done; badge) · More (Saved, Invoices, Mart, Notifications,
  Profile, Help, Switch to selling).
- **Provider tabs:** Home (to-do) · Leads (badge: new + expiring) · Orders (badge: to accept +
  revisions) · Earnings (next payout first) · More (Listings, Goods, Reviews, Munshi, Profile, Help,
  Switch to buying).
- **Header:** logo → own home · Buying/Selling switch (dual-profile only) · bell · avatar.
- **Admin:** grouped sidebar — Queues (with counts) / Records / Config / Audit; logo → `/admin`.
- **Every detail page:** `PageHeader` with back to its list and a real title.

### C6. Mobile app (`apps/mobile`)
| Sev | Finding | Evidence |
|---|---|---|
| S1 | **"Become a provider" → route with no screen** (registered in the layout, no file) ✔ | `(auth)/_layout.tsx:15`; `(app)/home.tsx:113`; `(app)/partner.tsx:152` ✔ |
| S1 | ~17 detail routes are hidden `Tabs.Screen`s, not a stack → Android back likely jumps to Home, no swipe-back, stale data flash, all tabs stay mounted | `(app)/_layout.tsx:112-128` |
| S1 | Long forms (RFQ new, quote composer, order review/dispute) lack keyboard avoidance / `keyboardShouldPersistTaps` | `rfq/new.tsx`; `partner-rfq/[id].tsx`; `orders/[id].tsx` |
| S1 | No font-scale limits and many fixed heights → clipping at Android "Largest"/200 % | `home.tsx:45-46`; `mart/pool/[id].tsx:142-143`; `mart/index.tsx:97-99` |
| S2 | No pull-to-refresh anywhere; every list is ScrollView + map; search/category stop at 24 items though the API pages | `search.tsx:28,97-102`; `category/[slug].tsx:25` |
| S2 | No offline handling or cache; bare spinners; uncached RN `<Image>` | `mart/*`, `components/mart/ProductCard.tsx:30` |
| S2 | No Account screen (sign-out is a small Home header link; language toggle only on Home); Partner tab shown to every buyer; 6 tabs at 360 dp | `home.tsx:32-57`; `_layout.tsx:66-110` |
| S2 | Noto Telugu loaded but never applied; Tailwind `sans` = Inter, never loaded; pixel line-heights | `app/_layout.tsx:16`; `tailwind.config.js:52-66` |
| S2 | Order actions on one tap; Razorpay not wired | `orders/[id].tsx:43,77`; `checkout/[packageId].tsx:40` |
| S3 | Missing native affordances: push, share, masked call/WhatsApp relay, camera/gallery capture, biometric gate before money actions, update prompt (EAS id is a placeholder), rating prompt, haptics | see sweep table |

### C7. Localisation
| Sev | Finding | Evidence |
|---|---|---|
| S1 | **Telugu stops after the gateway (web)**: common 0/28, auth 0/40, checkout 0/20, catalog 0/89, errors 0/20, legal 0/79 — a te user gets a Telugu landing then English sign-in, checkout and consent | `messages/te.json` (927 vs 2290 keys) |
| S1 | Mobile te: 180/649 keys (only munshi + mart); toggle still offers తె | `apps/mobile/messages`; `LocaleToggle.tsx:10` |
| S1 | Tamil routed on web (347/2290) but not in `locales.ts` (profile APIs reject it); no mobile ta | `i18n/routing.ts:7` vs `packages/shared/src/locales.ts:15` |
| S1 | ~256 API routes return English sentences shown raw; Supabase auth errors shown raw on mobile | e.g. `reviews/[id]/reply/route.ts:36`; `mobile login.tsx:31,35,51` |
| S1 | Locale not persisted to the account on switch; mobile device-only; no first-run language choice; MsmeWizard forces te/ta → en ⇒ **WhatsApp/SMS/email in the wrong language** | `mobile/lib/i18n.tsx:48,59`; `MsmeWizard.tsx:74-77` |
| S2 | Dates hard-coded `'en-IN'` (~34 web, 4 mobile) with a literal " IST"; no relative time; `useFormatter` unused | `mobile notifications.tsx:77`, `orders/[id].tsx:95` |
| S2 | Plurals: mobile has none ("1 products"); number+label concatenation breaks word order; web ICU plurals in only 17 strings | `mobile i18n.tsx:69`; `search.tsx:98`; `en.json:2089-2090` |
| S2 | Search: English stemmer over en/hi titles; te and category names not indexed; no synonyms (GST ≠ जीएसटी), no fuzzy | `migrations/0000_*.sql:514-517`; `0022_*.sql:107-108` |
| S2 | Voice RFQ replaces the speaker's words with the English parse | `mobile rfq/new.tsx:115-117` |
| S2 | Reference data English-only: 36 states (`packages/shared/src/states.ts:6`); categories en/hi only (`categories.ts:26`) | — |
| S3 | No lakh/crore wording; `formatResponseTime` returns English "~3h"; hard-coded English aria-labels/placeholders listed in C2/C3 | `lib/format.ts` (both apps) |

Web font loading is already right (per-locale Noto, rupee-glyph subset, `lang` set) — keep it.

---

## Part D — Shared domain input kit (build once in `packages/shared` + thin UI per app)
| Kit item | Behaviour | Replaces |
|---|---|---|
| `normalizeIndianPhone` + `PhoneInput` | +91 prefix, strips `+91`/`91`/`0` then keeps the **last** 10, live validity | `PhoneStep.tsx:74`, `GoodsCheckoutClient.tsx:149`, `GoodsRfqForm`, `PoolJoin`, mobile login/signup/cart |
| `OtpInput` | one `inputMode=numeric maxLength=6 autocomplete=one-time-code` field drawn as 6 fluid cells; WebOTP; any-length paste; single guarded auto-submit; resend timer; edit-number link | `OtpStep.tsx:115-126`, mobile OTP |
| `parseGstin` + `GstinInput` | uppercase, 15 chars, live checksum, derives **state** and **PAN**, example helper | 5 GSTIN fields |
| `PanInput`, `IfscInput` (+ bank/branch lookup), `UdyamInput` | masks + live validation | `ProviderWizard.tsx:714,824`, `MsmeWizard.tsx:259` |
| `PincodeInput` | 6 digits → city/state | goods checkout, goods RFQ, pools, MSME profile (new) |
| `StateCombobox` | 36 states/UTs, localised names, search, preselected from GSTIN/pincode/profile, never a hard default | 9+ selects; gateway "Other" |
| `MoneyInput` / `PercentInput` | ₹ + Indian grouping → paise; % shown, bps stored; optional "₹1.5 lakh" hint | RFQ budget, quote, package, catalog tiers, admin refund/coupon/commission |
| `DateInput` | IST-safe today, min/max, start/end-of-day correctness | RFQ needed-by, quote valid-until, coupons, CMS |

---

## Part E — Sequenced plan (one PR each; after the P0 security/money PRs in the companion doc)
1. **Foundations** — type scale 16–17 px, `:lang()` Indic rules, weight 500, secondary colour to 7:1,
   global min-height for form controls, `color-scheme`, stale vars; lint rules from A3. *(Low risk,
   visible everywhere.)*
2. **Error-code contract** (B2) + translated error catalogue; kill raw messages on web + mobile.
3. **Confirm & consequence** (B7) — `ConfirmSheet` + preview endpoint; wire quote accept, accept
   delivery, cancel, revision (with reason), admin refund/release.
4. **Shared input kit** (Part D) + `FormField` + `useDraft`; fix phone paste, OTP overflow/autofill,
   ListBuilder loss, wizard bank-draft bug, goods checkout state/GST.
5. **`nextActionFor` + role-aware shell** (B1, B5) — tabs, badges, to-do queues, `PageHeader`, titles,
   stepper with countdowns, success moments.
6. **Locale architecture** (B4) — account locale sync, first-run picker, shared formatters, plurals,
   localised states/categories, Telugu core-path translation, Tamil decision, search config + synonyms.
7. **Mobile structure** (B9) — stacks per tab, missing provider signup screen, keyboard, font scaling,
   FlatList + pull-to-refresh + offline cache, `expo-image`, Account screen.
8. **Feedback polish** — toasts on every mutation, skeletons per page, error/404 inside shells,
   empty-state CTAs, deep-link builder (B8), help-in-context.
9. **Design tokens package** (B6) + Storybook + visual regression + pseudo-locale in CI (A3).
10. **Native affordances** — push, share, masked call/WhatsApp relay, capture, biometric gate, update
    prompt.

---

## Status after PR #15 (2026-09-23)

**Done:** C1 type scale (base 16 px), `:lang(hi|te|ta)` line-height/tracking, weight 500, secondary text to
7.8:1, `color-scheme: light`, 44 px min-height on form controls, 24 px consent checkbox, `rounded-input`
defined, stale CSS vars synced · `ConfirmSheet` (C2) wired into quote accept, order actions, admin dispute
resolution, withdraw quote · C3 phone paste (`normalizeIndianPhone`, shared + tests), fluid autofill OTP
(web) + autofill/resend/auto-submit (mobile), ListBuilder text never lost, wizard bank-draft guard, Telugu
options, goods checkout state/GST refresh + disabled-Pay reason, checkout GSTIN/coupon labels, coded +
translated checkout errors, camera vs file picker split · C4 order stepper-lite (next-step line, revisions,
auto-accept deadline, translated events, payment-held banner, refund) · C5 visible 44 px language switcher,
grievance link · C6 mobile partner-signup screen, order-screen parity · C7 te/ta notification copy.

**Open** (Part E order): error-code contract beyond checkout (B2) · `nextActionFor` + role-aware shell with
tabs/badges/to-do queues/page titles (B1, B5) · shared input kit remainder (GSTIN→state/PAN, pincode,
StateCombobox, MoneyInput, DateInput) · locale architecture (account locale sync on switch, first-run picker,
shared date/plural formatters, localised states/categories, cross-script search) · mobile stacks per tab,
keyboard avoidance, font scaling, FlatList/pull-to-refresh/offline cache · design-tokens package, Storybook,
visual regression + pseudo-locale in CI · native affordances (push, share, masked call, capture).
