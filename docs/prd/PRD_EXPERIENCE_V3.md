# PRD: AMClub Experience v3, "Precision"

**Scope:** storefront, trust, flows and design language for buyers and providers, on web and mobile.

| | |
|---|---|
| **Status** | **APPROVED** by the founder, 2026-09-23 (DESIGN.md §8.7), including D-PRD2. Building in the §8 wave order; the agent programme is paused after S3.2. |
| **Date** | 2026-09-23 |
| **Decision owner** | Founder |
| **Author** | Claude Code |
| **Governance** | This document is the **§8.1 mini-PRD bundle** for everything the September 2026 survey recommends. Every epic has its own RICE score, flag and acceptance criteria. **Nothing is built until the founder approves that epic.** Epics that touch money, auth or the order state machine also need the ADR named in them (§8.4). When an epic is approved: DESIGN.md §8 records it, and FRONTEND.md moves to v3 as §3 of this PRD describes. |
| **Inputs** | `docs/market/SURVEY_2026-09.md` (19 portals, verified against the code), `docs/market/REPORT_1_FEATURES_AND_MOAT.md`, `docs/market/REPORT_2_UX.md`, the code at `2de8d48`, `docs/FRONTEND.md` v2, `docs/DESIGN.md` |
| **Non-negotiables carried in** | One spine (no second money path). Money computed on the server only. State machines only in `state-machines.ts`, extended, never repurposed. RLS on every new table. Every string through `next-intl`. Zod first. Money in paise. UTC stored, IST shown. Feature flags; ship dark. The NOT-NOW register. |

---

## Contents
1. Why this PRD exists
2. Goals, non-goals, success metrics
3. Design language v3: "Precision"
4. Information architecture and navigation
5. The pairing matrix: every UX gap paired with a feature, or a new feature created
6. Epics E0–E17 (requirements, wireframes, data, events, acceptance, RICE)
7. Cross-cutting requirements
8. Release plan and what it displaces
9. Risks
10. Decisions required
- Appendix A: traceability from survey IDs to epics
- Appendix B: new schema and API summary
- Appendix C: analytics event catalogue

---

## 1. Why this PRD exists

The September survey compared AMClub with 19 portals, and every claim about AMClub was checked against the code. It found three things.

1. **We own the best transaction loop and the weakest storefront.**
   - **The loop:** a logged-in buyer goes from search to Razorpay in 4 clicks and from a quote to payment in 2. Escrow, capped and masked quotes, clarifications visible to every quoter, and verified-purchase reviews are all live. Nobody in the Indian market has that loop.
   - **Where we lag:** everything a buyer sees before deciding.
     - **Trust:** hidden trust signals, initials instead of photos, and no nav in the logged-in web shells.
     - **Packages:** a single package per page, with no "choose this if…" and no add-ons.
     - **Search and RFQs:** filters are dropdowns, and the RFQ form has no guidance while typing.
2. **Twelve UX defects** (Report 2 §4). Two of them lose money:
   - a **new buyer's checkout is lost at signup**;
   - a **"member price" is shown that checkout never applies**.
3. **The moat is the loop's data:** closed prices, on-time rates, repeat buyers, dispute outcomes. That data is worthless to buyers until it's **visible** at the moment they choose.

**This PRD does four things:**
- **(a)** fixes the defects first (E0);
- **(b)** rebuilds every buyer and provider surface in a new, restrained, information-dense design language (§3, E1);
- **(c)** **pairs every UX gap with the feature that feeds it**, and where no feature exists, **creates one** (N1–N45, §5);
- **(d)** lays the data foundations the AI horizon needs (E15).

---

## 2. Goals, non-goals, success metrics

### 2.1 Goals
- **G1: Conversion.** Every surface between "I have a need" and "I paid" is at least as fast as today, and more convincing: trust visible, price honest, next step obvious.
- **G2: Trust made visible.** Outcome data we already compute reaches buyers as individual measured stats, above sample gates. The composite AMC Score is never shown (D1).
- **G3: Repeat.** Buyers come back through bundles, "buy again", reorder and a task-first home. Providers come back through a workspace that runs their day.
- **G4: Information density with calm.** Decision surfaces carry as many facts as Alibaba or 1688 but read like an Apple app: hierarchy from type and space, not boxes and colour.
- **G5: One distinctive identity.** Emerald & Brass, restrained. Nobody should mistake it for a SaaS template (Xometry) or a bazaar (IndiaMART).
- **G6: Parity.** Mobile and web offer the same flows for providers as well as buyers, and the buying path works in te and ta as well as en and hi.

### 2.2 Non-goals
- Anything on the NOT-NOW register (§8.3): auctions or bidding on RFQs, pre-order chat, cash payments, per-buyer negotiation, social feed, points, video consults, multi-currency, surge pricing, blockchain.
- A second money path, or new order states without an ADR.
- AMC Mart going live. E16 designs it, but it ships only behind the Mart Launch Gate.
- Switching agents on. Agent surfaces are designed here but keep their own gates and cohorts.
- A rebrand: colours, the jaali pattern and Noto type stay. A font change (see §3.4.2).
- Buyer memberships, featured placement, credit: these are LATER (§8.2 version gates).

### 2.3 Success metrics
**Primary (DESIGN §1.9 targets):**
- search→checkout ≥ 2.5 %
- RFQ→quote response ≥ 70 % within 48 h
- 90-day repeat ≥ 25 %
- dispute rate < 5 %
- review average ≥ 4.2
- providers onboarded (500 across 8 categories in 6 months)
- take rate 10–12 %

Baselines get measured at the start of the pilot; we have no volume yet.

**Experience metrics, per wave:**

| Metric | Target |
|---|---|
| Moderated tests (5 MSME owners + 5 providers, Hyderabad cluster, en/te) | ≥ 90 % completion on 6 core tasks; median task time ≤ today's |
| SUS | ≥ 80 |
| Core Web Vitals (mid-range Android, 4G, field data) | p75 LCP < 2.5 s, INP < 200 ms, CLS < 0.05 |
| Lighthouse (mobile) | ≥ 90 on public pages |
| axe | 0 critical, 0 serious |
| Contrast | body text ≥ 7:1 (FRONTEND.md law) |
| Money-path suites | the rigs stay green, and every epic touching money adds a rig criterion |

**Guardrails (must not regress):**
- dispute rate;
- refund complaints;
- support tickets per order;
- contact-leak attempts caught by masking;
- p75 LCP;
- Razorpay "payment failed / abandoned" rate.

---

## 3. Design language v3: "Precision"

### 3.1 The direction in one paragraph
**"Precision" is Emerald & Brass with the volume turned down and the resolution turned up.**
- **The volume:** v2 asked for flashy animations and lavish cards; v3 keeps the identity and drops the flash.
- **What replaces it:** Apple's discipline. Typography does the hierarchy, space does the grouping, colour marks only action and earned trust, and motion only explains.
- **Where density lives:** the 1688 / Alibaba information density moves into **data surfaces** (compare tables, provider workspaces, the list view of search), shown in tabular numerals with hairline separators.
- **Where calm stays:** first-time buyer surfaces keep Apple's calm.
- **The result:** a precise, prosperous institution. The one lavish moment per flow (Gold Stamp on accept, Paisa Moment on payment) feels earned because nothing else competes with it.

### 3.2 What changes versus FRONTEND.md v2

| Area | Keep | Change | Drop |
|---|---|---|---|
| Colour | All v2 tokens; the contrast law; gold only where earned | Neutrals do 90 % of the work (§3.4.1); emerald = action + selection; gold appears on ≤ 1 element per screen | Gold as decoration; gold-edge shimmer on every verified card |
| Backgrounds | Ivory; the jaali-blueprint lattice | Jaali only on hero, success and empty states, at 3–4 % | Jaali behind any list |
| Cards | 3 elevation levels; the two-layer shadow | Fewer cards: lists become grouped rows with hairlines (Apple "inset grouped"); cards only for objects you can act on | Card-in-card; boxes around every section |
| Type | Noto Sans + Indic companions; tabular money | A strict ramp (§3.4.2), optical tracking on large sizes, large titles that collapse on scroll | Ad-hoc sizes |
| Motion | Gold Stamp (the brand gesture); Paisa Moment; Gold Thread timeline; reduced-motion fallbacks | Spring physics for sheets and navigation; Paisa Moment ≤ 900 ms (was 1.4 s); count-up only on hero money | Shimmer sweeps, Molten Fill on non-score bars, per-card entrance scatter, Lathe Spinner (skeletons replace it) |
| Surfaces | Sticky primary action, 48 dp targets | Translucent bars (material) on capable devices; sheets with detents; segmented controls; a left rail on desktop | Native `<select>` for ≤ 5 options |
| Data | Zerodha-style ledger | A **Compact density** mode for data views (§3.5) | — |

**Why:** v2 was written before the product had dense decision surfaces (compare, inbox, trust panel) and before the survey. Its "one lavish element per screen" rule survives. Its flash budget doesn't.

### 3.3 The three bars this design must clear

**A. "Better than Xometry."** Xometry is clean but generic: a white SaaS shell with grey cards, strike-through "save $X" anchors, and an accept-only cookie banner. We beat it on six measurable points:
1. **Identity:** recognisable within 1 second (emerald/brass, the hairline, the jaali on hero), yet quieter than Xometry on data screens.
2. **Price clarity:** every price shows its tax; every option shows its delta ("+₹500 · 2 days sooner"). No fake anchors.
3. **One screen per decision:** Xometry's configurator + options + sidebar becomes our tier tabs + comparison matrix + sticky buy box.
4. **Speed:** p75 LCP < 2.5 s on a mid-range Android over 4G. Xometry is desktop-first.
5. **Language:** 4 locales plus voice. Xometry is English only.
6. **Honesty:** no pre-ticked boxes, no accept-only consent, no countdowns.

**B. "As information-dense as 1688 / Alibaba."** Density is measured in decision facts per viewport, not in boxes.

| Surface (at 390 × 844 unless noted) | Min decision facts visible without scrolling |
|---|---|
| Search result card | 7: name, credential, rating (n), one measured stat, delivery, response, price with GST |
| Search list view, desktop 1440 | 12 rows × 8 columns |
| Provider profile, above the fold | 10 (identity 3 + 4 stat tiles + 3 verification lines) |
| Package tier matrix | all tiers × ≥ 6 attributes on one screen at desktop, 2 tiers at mobile with swipe |
| Quote compare, desktop | all quotes (up to 7) × 12 attributes, sticky label column |
| Provider RFQ inbox, desktop Compact | 20 rows × 7 columns |

Density techniques:
- **Numbers:** tabular numerals; right-aligned numbers; units in headers.
- **Separators:** hairlines instead of boxes.
- **Secondary facts:** progressive disclosure (a disclosure row, never a modal).
- **Row height:** Compact mode 36 px on data views.
- **Text:** abbreviations only from a fixed glossary.

**C. "Slick, like Apple."** The specific techniques we adopt, adapted from Apple's Human Interface Guidelines:
1. **Large titles** that collapse into the translucent navigation bar on scroll.
2. **Inset grouped lists:** rows grouped on a raised surface with hairline separators and a section header in footnote style.
3. **Sheets with detents** (medium / large) for filters, confirms and pickers. They keep context; full-page modals don't.
4. **Segmented controls** for 2–5 mutually exclusive options.
5. **Materials:** translucent, blurred bars (vibrancy) that let content scroll beneath.
6. **SF-Symbols-like iconography:** one line icon family, one stroke weight, a filled variant for selected state.
7. **Spring motion** with continuity: an element that opens from a card returns into that card.
8. **Haptics** on mobile for selection, success and warning. Never on scroll.
9. **Typographic restraint:** two weights per view, one accent colour per view.
10. **Direct manipulation:** swipe to shortlist or remove on mobile lists, long-press for quick actions, and pull-to-refresh where data changes.

### 3.4 Tokens

#### 3.4.1 Colour (semantic layer on top of the v2 palette)

| Semantic token | Light value | Use |
|---|---|---|
| `bg/base` | ivory `#FCFAF3` | app background |
| `bg/raised` | porcelain `#FFFFFF` | grouped lists, cards, sheets |
| `bg/sunken` | `#F4F1E8` | inputs, table header rows, segmented-control track |
| `fill/quiet` | `rgba(10,46,34,0.05)` | chips at rest, hover |
| `text/primary` | emerald-ink `#0A2E22` | body, titles (≥ 7:1) |
| `text/secondary` | `#3F5A50` | metadata (≥ 7:1 on ivory; check at build) |
| `text/tertiary` | `#5F7169` | captions, placeholders (≥ 4.5:1; never for money) |
| `text/numeric` | ink `#14161A` | all money and stats |
| `separator` | brass-line `#B08D2A` at 35 % | hairlines on raised surfaces |
| `separator/strong` | brass-line 100 % | the one signature hairline (top of cards, section rule) |
| `accent` | emerald `#0E6B4F` | primary buttons, selection, links, focus ring |
| `accent/pressed` | `#0A5540` | pressed state |
| `earned` | the gold gradient (v2) | verified seal, accepted quote, payout, won. **≤ 1 per screen** |
| `positive` | `#1F7A4D` | success text / icons |
| `caution` | `#8A5A00` on `#FFF4DB` | deadlines, "not stated" |
| `critical` | stamp-red `#A63A2B` | errors, disputes only |

**Dark mode (optional, D-PRD1):** `bg/base #0B1411`, `bg/raised #121D18`, `text/primary #EDEBE3`, accent `#2FA37C`, earned gold unchanged, separator brass at 30 %. Light stays the default because of shop-floor sunlight (FRONTEND §1).

#### 3.4.2 Typography
- **Families:** Noto Sans (Latin) + Noto Sans Devanagari / Telugu / Tamil; the 2 KB rupee subset stays first in the stack.
- **No font change.** The current setup is performance-tuned: `display: optional`, one family, locale-scoped Indic faces. We get Apple's feel from the scale, tracking and weights, not the face.

**Ramp** (px; mobile / desktop; line-height):

| Style | Mobile | Desktop | Weight | Tracking | Use |
|---|---|---|---|---|---|
| Display | — | 44/48 | 700 | −0.022em | desktop hero only |
| Large title | 32/38 | 36/42 | 700 | −0.02em | page titles (collapse on scroll) |
| Title 1 | 26/32 | 28/34 | 700 | −0.018em | section heroes |
| Title 2 | 22/28 | 22/28 | 600 | −0.012em | card titles, sheet titles |
| Title 3 | 19/24 | 20/26 | 600 | −0.008em | group headers |
| Headline | 17/22 | 16/22 | 600 | 0 | row titles |
| Body | 17/26 | 15/22 | 400 | 0 | text (mobile body stays 17/26 per FRONTEND) |
| Callout | 16/22 | 14/20 | 500 | 0 | buttons, chips |
| Subhead | 15/20 | 13/18 | 400 | 0 | metadata |
| Footnote | 13/18 | 12/16 | 400 | 0 | section headers (sentence case), legal lines |
| Money L | 30/34 | 32/36 | 600 | −0.01em | hero prices (tabular) |
| Money M | 20/24 | 18/22 | 600 | 0 | card prices (tabular) |
| Numeric S | 15/20 | 13/18 | 500 | 0 | table numbers (tabular, right-aligned) |

- **Indic scripts:** the same sizes, with line-height +12 % and no negative tracking.
- **Weights:** at most two weights per component.
- **Case:** no all-caps anywhere; sentence case (FRONTEND §2.4).

#### 3.4.3 Space, grid, radius, elevation, material
- **Spacing:** a 4 pt base: 4, 8, 12, 16, 20, 24, 32, 40, 56, 72. Chrome uses 16–24. Data uses 8–12.
- **Grid:**

  | Screen | Columns | Gutter | Side margin |
  |---|---|---|---|
  | Mobile, 360–430 | 4 | 16 | 16 |
  | Tablet, 768 | 8 | 20 | 24 |
  | Desktop, 1280 | 12 | 24 | max content 1200 |
  | Data views | full-bleed up to 1440 | — | — |

- **Radius:** 6 (chips, inputs) · 10 (cards; v2 value kept) · 14 (sheets, grouped lists) · 20 (modals, hero cards). Use continuous-looking curves, and progressive `corner-shape: squircle` where supported.
- **Elevation:** 3 levels (FRONTEND §2.3). Shadows as in v2 but at 70 % strength. Hairlines are 0.5 px on ≥ 2× displays.
- **Material** (translucent bars and sticky action bars): `backdrop-filter: blur(20px) saturate(180%)` over `bg/base` at 72 %.
  - **Fallback:** solid `bg/base` at 96 % when `prefers-reduced-transparency`, when `navigator.deviceMemory` ≤ 2, or when `backdrop-filter` is unsupported.
- **Iconography:** `lucide-react` (already a dependency), 1.5 px stroke, 20 / 24 px. Selected state uses a filled or emerald variant. Money and status icons come from a fixed set of 24 (listed in the component library README).

#### 3.4.4 Motion
- **Springs:** sheets and navigation push at stiffness 380, damping 32 (≈ 300 ms settle). Chips and toggles at stiffness 600, damping 40.
- **Tweens:** 160–220 ms ease-out for fades. Transform and opacity only.
- **Continuity:** card → detail uses a shared-element transition (View Transitions API on web, falling back to a fade). Sheets originate from their trigger.
- **The signature set that survives:**
  - **Gold Stamp:** quote accept, buyer accepts delivery, admin release. ≤ 700 ms.
  - **Paisa Moment:** payment success, payout paid. ≤ 900 ms, skippable.
  - **Gold Thread:** the order timeline; draws only the newly completed segment.
- **Everything else:** no celebration.
- **Reduced motion:** every animation has an instant-state fallback.
- **Forbidden:** motion on tables and admin screens, and any motion while money is uncertain (FRONTEND §3.2).
- **Haptics (mobile, `expo-haptics`):** selection = light, success = notificationSuccess, warning = notificationWarning. None on scroll or page load.

### 3.5 Density system
- **Two modes:**
  - **Comfortable** (default for buyers, and on every first-time surface): rows 56 px.
  - **Compact** (default for the provider workspace, admin, the compare table and the search list view; buyers can opt in): rows 36–44 px.
- **Where the setting lives:** the user profile (`ui_density`), with a toggle in the avatar menu (N33).
- **Rules:** Compact never shrinks text below Footnote. Tap targets stay 48 dp through hit-slop even when the row is 36 px. Colour and weight don't change between modes; only the spacing does.

### 3.6 Components (the v3 library)
All components live in `apps/web/components/ui-v3/`, with React Native twins in `apps/mobile/components/ui-v3/`. They build only from tokens: no ad-hoc hex, shadows or animations (FRONTEND §9).

| Component | Replaces | Used on | Notes |
|---|---|---|---|
| `NavBar` (translucent, large-title collapse) | Headers | all | back, title, ≤ 2 trailing actions |
| `SideRail` (desktop) / `TabBar` (mobile) | Dashboard tiles as nav | buyer, provider shells | badges from N2 |
| `SearchField` | `SearchBar` | header, search | scope token, mic (N5), clear; opens `SearchSheet` on mobile |
| `CommandSearch` (⌘K) | — | desktop logged-in | N3 |
| `FilterChipBar` + `FilterSheet` | `ListingControls` selects | search, inbox | ≤ 5 chips + "More" |
| `SegmentedControl` | `<select>` with ≤ 5 options | everywhere | 44 dp segments |
| `Picker` (sheet list with search) | `<select>` with > 5 options | state, category | recent + search |
| `ResultCard v3` / `ResultRow` (list view) | `ResultCard` | search, category | §E3 anatomy |
| `StatTile` / `StatChip` | Meta text | profile, cards | value (tabular) + label + sample note |
| `TrustPanel` + `VerificationChecklist` | `VerificationBadges` chips | profile, package | method + date per check (N10) |
| `PriceBlock v3` | `PriceBlock` | everywhere | server values only; "+ GST" / "= total" (N16) |
| `TierTabs` + `ComparisonMatrix` | Single-package page | package | N14 |
| `AddOnList` | — | package, checkout | N15 (ADR) |
| `StickyActionBar` | Inline CTAs on mobile | package, profile, RFQ, order | material; safe-area aware |
| `Sheet` (detents) / `ConfirmSheet` | Existing sheets | global | spring; drag to dismiss |
| `StrengthMeter` | — | RFQ | N19 |
| `SuggestionList` | — | RFQ (documents), search | N19 |
| `CompareTable v3` | `QuoteCompare` table | compare, shortlist compare | sticky header and column; Compact |
| `NextStepBar` | Actions card | order | N23 |
| `SectionTabs` | Long page | order, profile | anchor tabs that scroll-spy |
| `ActionList` ("Needs your action") | Tiles | buyer home, provider home | N2 / N25 |
| `MessageThread` | Quote thread | quote, order | N24; masked |
| `Timeline` (Gold Thread) | Timeline | order | v2 signature kept |
| `FunnelBar` | — | provider home | N29 |
| `DataTable` | Ad-hoc tables | inbox, earnings, admin | Compact, sticky header, keyboard nav |
| `EmptyState` / `Skeleton` / `Banner` / `Toast` | Mixed | global | skeletons replace spinners |
| `Stepper` | Wizard progress | onboarding, signup | labelled steps |
| `InlineAuth` | Redirect to /login | checkout, RFQ | N1 |

### 3.7 Content rules
- **Prices:**
  - Always from the server.
  - Always with their tax state: "₹1,499 + GST" on cards; "₹1,499 + 18 % GST = ₹1,768.82" on detail and checkout.
  - Never a struck-through price unless the discount is real and applied at checkout.
- **Dates:** shown in IST as "Mon 29 Sep". Relative ("in 5 h") only under 48 h. Always give a deadline with a consequence: "Accept by 6 pm — or it auto-cancels with a full refund".
- **Numbers:** Indian grouping (₹1,23,456). Percentages without decimals unless under 10. Every stat carries its sample: "96 % on time · 48 orders".
- **Voice:**
  - Plain and specific.
  - No "Oops".
  - No urgency theatre.
  - The platform's promises stated once, calmly: "Your number stays hidden." "Money held until you accept."
- **Indic:** every string in en, hi, te and ta for the buying path (E14). Units and numerals stay Latin digits unless a locale requires otherwise (decision in E14).

### 3.8 Accessibility and performance budgets
- **Accessibility:**
  - WCAG 2.2 AA minimum, and 7:1 for body text.
  - Visible focus: a 2 px emerald ring, offset 2 px.
  - Every icon-only control labelled.
  - Sheets trap focus and return it on close.
  - Tables use real `<table>` semantics with header scopes.
  - axe runs on every public surface (it's already in CI) and on logged-in surfaces through Playwright fixtures (E1).
- **Performance:**
  - JS ≤ 170 KB gzipped per route on first load for the buying path.
  - Images: AVIF/WebP with `srcset`.
  - Provider logos ≤ 20 KB at 96 px.
  - No layout shift from fonts (the current `display: optional` setup stays).
  - Materials are disabled on low-memory devices (§3.4.3).

---

## 4. Information architecture and navigation

### 4.1 Sitemap v3 (changes against the 56 live pages)

**Public:**

| Path | Change |
|---|---|
| `/` | Gateway stays |
| `/services` | Becomes "Browse": categories + search |
| `/services/[category]` | Gains sibling chips and a list/grid toggle |
| `/services/[category]/[service]` | **New.** Level-2 landing page. Uses the `parent_id` taxonomy; SEO; tier-matrix aggregation |
| `/p/[providerSlug]` | Tabs: Packages · About · Reviews · Credentials |
| `/p/[providerSlug]/[packageSlug]` | Tier-aware |
| `/compare?items=` | **New.** Shortlist compare (N34), up to 4 providers or packages |
| `/help`, `/terms`, `/privacy`, `/refund-policy`, `/grievance`, `/provider-addendum` | Unchanged |

**Buyer (`/app`):**

| Path | Change |
|---|---|
| `/app` | Home, task-first |
| `/app/search` | **Linked** from nav; same engine as `/services`, plus "my stuff" in universal search |
| `/app/requirements` | Renamed from `/app/rfq`, which stays as a redirect. Requirements list + drafts |
| `/app/requirements/new` | RFQ v3 |
| `/app/requirements/[id]` | Compare v3 |
| `/app/orders`, `/app/orders/[id]` | Workspace v3 |
| `/app/saved` | Providers + packages + shortlists |
| `/app/checkout/[packageId]` | Checkout v3 |
| `/app/invoices`, `/app/notifications`, `/app/profile` | Unchanged |
| `/app/plans` | **New**, gated with E12: bundles and subscriptions the buyer holds |

**Provider (`/partner`):**
- `/partner`: Today, task-first.
- `/partner/rfqs`: Inbox v3.
- `/partner/orders`, `/partner/listings` (tiers, add-ons), `/partner/earnings`, `/partner/reviews`, `/partner/profile`: carried over.
- `/partner/insights`: **new**, the funnel (N29).
- `/partner/tenders`: **new**, gated D9.

**Admin:** unchanged, except for Compact density and the new review tools each epic names.

### 4.2 Navigation models

| Shell | Mobile | Desktop | Always visible |
|---|---|---|---|
| Public | Top bar: logo · search icon · language · Sign in; hamburger → Services, Post a requirement, For providers | Top bar: logo · **Services** (mega-menu) · search field (mic) · **Post a requirement** (primary) · language · Sign in | "Post a requirement" |
| Buyer | **TabBar**: Home · Search · Requirements · Orders · Saved (+ Mart when live) | **SideRail**, same items + Invoices, Profile; ⌘K | Bell, avatar |
| Provider | **TabBar**: Today · RFQs · Orders · Listings · Earnings | **SideRail**, same + Insights, Reviews, Profile, Tenders (gated) | Bell, avatar, density toggle |

- **Badges come from one endpoint (N2):**
  - Buyer: Requirements (quotes waiting), Orders (action needed).
  - Provider: RFQs (new matches), Orders (action needed).
- **Mega-menu:** 8 categories × top 3 level-2 services + "All services". Nothing else; no tools or ads.
- **Universal search (N3):**
  - Everyone: services, providers, categories.
  - Logged in, also: my requirements, orders and invoices.
  - Desktop opens it with ⌘K; mobile uses a full-screen sheet.
- **Deep links:** every WhatsApp and email notification links to the exact object and action, e.g. `/app/requirements/[id]#quote-B`.

---

## 5. The pairing matrix

Each row is a UX element the survey found missing or weak. It's **paired with the feature that feeds it**:
- a Report 1 gap;
- a survey foundation (F1–F10); or
- a **new feature (N-number)** where no feature existed.

**Feature status:**
- **Live** exists and is live.
- **Dark** exists behind a flag.
- **Part** is partial.
- **Missing** is a known gap from Report 1.
- **New** is created by this PRD.

| # | UX element | Surface | Paired feature | Feature status | Epic | Gate |
|---|---|---|---|---|---|---|
| P1 | Checkout that survives signup | checkout | **N1** intent-preserving auth | New | E0/E5 | Now |
| P2 | Remove the "member price" line | cards, package | Membership tiers | Missing (LATER) → hide | E0 | Now |
| P3 | Sticky buy bar on phones | package | **N16** server price display | New | E0/E4 | Now |
| P4 | Persistent nav + badges | shells | **N2** action counts | New | E1 | Now |
| P5 | Mega-menu, level-2 pages | public | Service taxonomy L2 (`categories.parent_id`) | Part (column exists, unused) | E1/E2 | Now |
| P6 | Universal search / ⌘K | all | **N3** universal search | New | E1 | Now |
| P7 | Filter chips + sheet; full state list; category filter | search | **N4** facets v2 | New | E2 | Now |
| P8 | Sibling-category chips | search | Taxonomy L2 | Part | E2 | Now |
| P9 | Mic in the search field | search | **N5** voice search | New (reuses the voice RFQ pipeline, Live) | E2 | Now |
| P10 | "Did you find it?" thumbs | search | **N6** relevance feedback (F5) | New | E2/E15 | Now |
| P11 | Zero-result → prefilled requirement | search | **N7** search→RFQ carry-over | New | E2 | Now |
| P12 | Recently viewed | home, search | **N8** recently viewed | New | E2/E9 | Now |
| P13 | Shortlist compare tray | search, saved | **N34** shortlist compare | New | E2 | Now |
| P14 | List view (dense rows) | search | **N4** facets v2 + `ResultRow` | New | E2 | Now |
| P15 | Photo/logo on cards | cards, profile | **N12** provider media | Part (logo used for OG only) | E3 | Now |
| P16 | One measured stat on the card; 4 stat tiles on the profile | cards, profile | **N9** public measured stats | New (inputs Live in the score) | E3 | **D1** + ADR-010 amendment |
| P17 | Verification checklist with method + date | profile, package | **N10** verification evidence (F4) | Part (chips only) | E3 | Now |
| P18 | Member since, years in practice | profile | Firmographics | Part (captured, not shown) | E3 | Now |
| P19 | "Active this week" | cards, profile | **N11** activity + availability (`last_seen_at` writer) | Part (column unused) | E3 | Now |
| P20 | "Next available start" | profile, package | **N11** availability | New | E3 | Now |
| P21 | Reviews v3: histogram, "repeat buyer" marker, load more | profile | **N13** reviews v2 | New | E3 | Now |
| P22 | AI review summary (cited) | profile | AI summary (FV-12) | Missing → Dark | E3 | agent gate |
| P23 | Tier tabs + comparison matrix + "choose this if" | package | **N14** package tiers | Missing | E4 | Now (schema) |
| P24 | "₹X + 18 % GST = ₹Y" everywhere | all prices | **N16** server price display | New | E4 | Now |
| P25 | Refund line on the package | package | Refund policy summary | Live policy, not surfaced | E4 | Now |
| P26 | Government-dependency line | package | **N17** `categories.govt_dependent` | New | E4 | Now |
| P27 | Priced add-ons | package, checkout | **N15** add-ons | Missing | E12 | **ADR** |
| P28 | Bundle / plan page (registration + 12-month filing) | package, `/app/plans` | **N18** compliance bundles | Missing | E12 | **ADR** |
| P29 | ITC line at checkout | checkout | **N16** + buyer GSTIN | Part (Mart has it) | E5 | Now |
| P30 | "What happens next" block | checkout | Order state machine | Live | E5 | Now |
| P31 | RFQ strength meter | RFQ | **N19** client-side quality rules (shared `rfq-quality`) | Part (server-side only) | E6 | Now |
| P32 | "Documents you'll likely need" | RFQ | **N19** document requirements + enrichment | New (rules) / Dark (model) | E6 | Now / agent |
| P33 | One free-text box; required marks; budget chips | RFQ | Typed budget + needed-by | Live | E6 | Now |
| P34 | Must-haves (credential, language, on-site) | RFQ | **N19** must-haves typed (F2) | New | E6 | Now |
| P35 | "Quotes usually arrive within X h" | RFQ, compare | **N38** quote SLA stat | New | E6 | Now |
| P36 | Entry points (header, search, profile, package, home) | global | **N20** prefill contract | New | E6 | Now |
| P37 | Scope text in the desktop compare table | compare | Quote scope | Live | E7 | Now |
| P38 | Fair-price line on compare | compare | Benchmarks (S3.2) | Dark | E7 | volume gate |
| P39 | Reliability ordering | compare | Score-based ranking | Dark | E7 | **D1** |
| P40 | Speed-tier columns | compare, quote form | **N21** quote speed tiers | Missing | E12b (shown in E7) | **ADR** |
| P41 | Loss reasons feed analytics | compare → provider insights | **N22** quote-loss labels (F1) | Part (decline enum Live) | E7/E11 | Now |
| P42 | Next-step bar | order | **N23** next-action selector | New | E8 | Now |
| P43 | Section tabs | order, profile | — | UI only | E8 | Now |
| P44 | Messages inside an order | order | **N24** order messaging (masked) | Missing (PRD M6) | E8 | Now |
| P45 | "Payment secured ✓" | provider order view | **N37** funded signal | Live data, not shown | E8 | Now |
| P46 | Delay compensation | order | First-order guarantee | ADR-011 (blocked on H7) | — | ADR-011 |
| P47 | "Needs your action" (buyer) | home | **N25** = N2 detail list | New | E9 | Now |
| P48 | "Pick up where you left off" | home | **N8** + RFQ drafts | New / Live (drafts) | E9 | Now |
| P49 | Buy again / repeat requirement | home, orders | **N26** reorder | Missing | E9 | Now |
| P50 | Onboarding stepper, "what you'll need", GSTIN autofill of 4 fields | provider onboarding | **N27** onboarding v2 | Part (legal name only) | E10 | Now |
| P51 | PAN path | provider onboarding | **N27b** GST-exempt providers | Missing | E10 | **D3** + ADR |
| P52 | Step analytics + drop-off nudge | provider onboarding | **N27c** | Part (gateway only) | E10 | Now |
| P53 | Inbox filters, sort, Compact table | provider inbox | **N28** inbox v2 | New | E11 | Now |
| P54 | "Buyer verified" badge on RFQs | provider inbox | **N28b** buyer verification signal | Missing | E11 | **D2** |
| P55 | Segmented GST/transport; required marks | quote form | Quote terms | Live | E11 | Now |
| P56 | Munshi draft inline | quote form | Munshi (S2.2) | Dark | E11 | agent gate |
| P57 | Funnel card; decline reasons | provider home, insights | **N29** provider funnel | New | E11 | Now |
| P58 | Payouts panel | provider home | Payouts | Live | E11 | Now |
| P59 | Tenders tab + GeM checklist | provider | **N30** tender alerts + checklist | Missing | E11 | **D9** / §8.1 |
| P60 | Mobile: listings, orders, earnings, reviews, profile for providers | mobile | **N31** mobile parity | Missing | E13 | Now |
| P61 | te/ta on the buying path | all | **N32** locale completion | Part (te 41 %, ta 18 %) | E14 | Now |
| P62 | Provider content in hi/te/ta | package, profile | **N32b** content translation (provider approves) | Missing → Dark | E14 | agent gate |
| P63 | Density toggle | shells | **N33** density preference | New | E1 | Now |
| P64 | Consent notice (if required) | global | **N36** analytics consent | New | E17 | Counsel (D-UX2) |
| P65 | Services / Goods switch; typed facets; promise filters; samples; ITC-ineligible note; non-returnable; reorder | Mart | **N39–N44** | Missing / Dark | E16 | Mart Launch Gate |
| P66 | Shadow predictions feed future UI (price band, fit %) | compare, RFQ | **N35** foundations F1–F10 | New | E15 | Now (dark) |
| P67 | "Coming due" renewals + "What do I need?" checklist | buyer home | **N45** obligations router + reminders (F7) | New | E9 | **D-PRD5** (CA + counsel) |

### 5.1 New features created by this PRD (N-numbers)
| ID | Feature | One-line definition |
|---|---|---|
| N1 | Intent-preserving auth | Any auth or signup that interrupts checkout or RFQ creation returns the user to the exact intent. Inline OTP on checkout |
| N2 | Action counts | `GET /api/v1/me/actions`: counts + items needing the viewer's action, for nav badges and home lists |
| N3 | Universal search | One query over services, providers and categories (plus my orders, requirements and invoices when logged in); ⌘K / search sheet |
| N4 | Facets v2 | Category, full state list, city, credential type, response time, delivery ≤ N days, price bands; list view |
| N5 | Voice search | The mic in the search field. Speech → query text through the Phase 8b pipeline and its consent note; no audio retained |
| N6 | Relevance feedback | "Did you find it?" per results page + query/constraint logging (F5) |
| N7 | Search → requirement | Zero or weak results offer a requirement prefilled with the query and category |
| N8 | Recently viewed | The last 20 providers/packages, client-first, synced for logged-in users |
| N9 | Public measured stats | On-time %, repeat-buyer %, response rate, orders completed, each with its sample and a sample gate. Never the composite score |
| N10 | Verification evidence | Per check: kind, method (API / manual / vendor), verified_at, source, expiry; shown as a checklist |
| N11 | Activity + availability | `last_seen_at` written on authenticated activity; provider-set `next_available_on` or one derived from the active queue |
| N12 | Provider media | Logo/photo upload with a size cap, rendered on cards and profile |
| N13 | Reviews v2 | Cursor pagination, rating histogram, "repeat buyer" marker (buyer ≥ 2 paid orders with that provider); sub-scores later |
| N14 | Package tiers | A package group with up to 3 tiers (label, "choose this if", comparison attributes) |
| N15 | Add-ons (ADR) | Up to 3 priced extras per package (+₹, +days), priced by `computeOrderAmounts` on the server |
| N16 | Server price display | Catalog, package and checkout APIs return taxable, GST, total and (for GSTIN buyers) the ITC amount; clients never compute |
| N17 | Government-dependent flag | A category/package flag that shows the government-portal disclaimer and links to the timer-pause behaviour |
| N18 | Compliance bundles (ADR) | Registration + N months of filings sold as one package, paid out by milestone from escrow |
| N19 | RFQ quality v2 | Client-side strength meter from shared rules; a document-requirements table per category/service; typed must-haves |
| N20 | Requirement prefill contract | `?q`, `?category`, `?service`, `?from_package`, `?from_provider` accepted by the requirement form (validated with Zod) |
| N21 | Quote speed tiers (ADR) | A quote may carry up to 3 options (price, days); the buyer picks one at accept |
| N22 | Quote-loss labels | On accept, every other quote gets a system label with its price and delivery deltas against the winner (F1) |
| N23 | Next-action selector | A shared function (status, role, facts) → the one next action + deadline, used by the order bar, home lists and notifications |
| N24 | Order messaging | Order-scoped masked threads between buyer and provider after payment |
| N25 | Buyer action list | The item list behind N2 for the buyer home |
| N26 | Buy again / repeat requirement | One tap to re-buy a package or re-post a requirement with edits |
| N27 | Provider onboarding v2 | Stepper, "what you'll need", GSTIN autofill (legal name, trade name, state from the GSTIN's first 2 digits, address if the vendor returns it), step analytics; PAN path (N27b) behind D3 |
| N28 | Provider inbox v2 | Filters, sort, Compact table, buyer-verified badge (N28b, D2) |
| N29 | Provider funnel | Profile views → matched → quoted → won, with decline reasons, per week; server-side profile-view capture |
| N30 | Tenders + GeM checklist | Alert feed (D9) and a date-stamped GeM seller checklist inside the govt & licensing category |
| N31 | Mobile provider parity | Listings, provider orders list, earnings, reviews, profile on mobile |
| N32 | Locale completion + content translation | te/ta across the buying path; machine-drafted provider content in hi/te/ta that the provider approves (dark) |
| N33 | Density preference | `users.ui_density` (comfortable / compact) |
| N34 | Shortlist compare | Compare up to 4 providers or packages side by side before any RFQ |
| N35 | Data foundations | F1–F10 from the survey (§6.2), incl. the shadow-prediction ledger |
| N36 | Analytics consent | A notice with equal Accept/Decline if counsel requires it; PostHog waits for consent |
| N37 | Funded signal | "Payment secured" on every provider order view (derived: an order exists only after capture) |
| N38 | Quote SLA stat | Median first-quote time per category × state, shown when n ≥ 20 |
| N39–N44 | Mart storefront v2 | Dual mode, typed attributes/facets, seller promises, samples/customisation, non-returnable + ITC-ineligible, reorder library (E16) |
| N45 | Obligations router + renewal reminders | Licences held (F7) with 60/30/7-day reminders, and a sourced, CA-reviewed "businesses like yours usually hold…" checklist that routes to categories. Routing, never advice (D-PRD5) |

---

## 6. Epics

**How each epic is laid out:**
1. Problem
2. Pairs: rows of §5
3. Requirements: `FR-n.m`
4. UI spec and wireframe
5. Data and API
6. Events
7. Flag
8. Gates
9. Acceptance
10. RICE

**How RICE is scored** (as in DESIGN §8.6):
- **Reach:** the share of relevant users, 0–1.
- **Impact:** 0.25 / 0.5 / 1 / 2 / 3, measured against §1.9 only.
- **Confidence:** 0.5–1.
- **Effort:** person-weeks.
- **Score:** R × I × C / E.

**Flags:** one PostHog flag per epic, rolled out 10 % → 50 % → 100 % with a kill switch. Money and agent items also keep their existing gates.

---

### E0: Fix first (the 12 defects)

**Problem.** These defects cost money or trust today, independent of any redesign (Report 2 §4).

**Pairs:** P1, P2, P3, plus interim fixes for P4, P7, P21 and P33.

**Requirements**

- **FR-0.1 (U1): a new buyer's purchase survives signup.**
  - `login` passes `next` into `/signup?complete=1&next=…` for new users.
  - `MsmeWizard` ends at `safeNext(next) ?? '/app'`.
  - The same applies to the provider path (`/partner/onboarding?next=`).
  - Guarded by the existing `safeNext` allow-list.
- **FR-0.2 (U2): hide every "member price" line** until memberships exist.
  - Add flag `member_pricing_enabled`, default false.
  - `member_extra_discount_bps` stays in the schema, untouched.
- **FR-0.3 (U3): sticky buy bar on the package page below the `lg` breakpoint.**
  - Price as shown today; "Buy now".
  - Safe-area aware; solid background (the material comes in E1).
- **FR-0.4 (U4): the provider page gets two CTAs above the fold.**
  - "See packages" (anchor).
  - "Post a requirement in <category>" (prefill contract N20, minimal: `?category=`).
- **FR-0.5 (U5): the search state filter uses all 37 states and UTs by name** from `packages/shared/src/states.ts`. Web gets a Picker sheet; mobile already has one.
- **FR-0.6 (U6): an interim "Search" link** in the buyer shell's avatar menu and home, until the E1 navigation ships.
- **FR-0.7 (U8): the mobile provider home reads real stats** from the same API as web.
- **FR-0.8 (U9): "Top Rated" is removed** from the card, the profile and the sort key until D1 decides its definition. Sort becomes rating weighted by review count.
- **FR-0.9 (U10): the RFQ form merges the template "notes" field and "Anything else" into one field.** Category and title show the required mark.
- **FR-0.10 (U11): "Show all reviews" links to a paginated list.** Minimal version of N13.
- **FR-0.11 (U12): the gateway's size band is saved.**
  - *As built:* `msme_profiles.employee_band` already existed (`1-9` | `10-49` | `50-249`, the gateway's own bands), so no migration: the wizard sends the band and `POST /profile/msme` stores it.
- **Not in E0:** U7 (messaging after payment) is medium-sized and lives in E8.

**Data and API.** *As built:* no new column (U12 uses `employee_band`). One migration, `0047_search_weighted_rating.sql` (U9's sort). New route `GET /api/v1/partner/stats` (U8). Rollback: re-run 0007's function body.

**Events:**

| Event | Properties |
|---|---|
| `signup_intent_restored` | `intent`: checkout / requirement |
| `provider_cta_clicked` | `cta` |

**Flag:** none for pure bug fixes. `member_pricing_enabled` for FR-0.2.

**Acceptance**
- Playwright: a new phone number → Buy now → OTP → wizard → lands on the same checkout with the same package → pays in simulate mode. Added to CI.
- No "member price" string renders anywhere while the flag is off (visible-markup assertion in en/hi/te).
- At 390 px, the package page shows the buy bar in the first viewport.
- The search state Picker lists 37 names.
- The mobile provider home shows the fixture's stats.
- "Top Rated" appears nowhere.
- The RFQ form has one free-text field.

**RICE:** R 1.0 · I 2 · C 0.9 · E 1.5 → **1.20**, the highest score in this PRD.

---

### E1: Design system v3 and navigation shells

**Problem.**
- The web app has no persistent navigation once you're logged in.
- There are 44 native dropdowns, most with ≤ 5 options.
- FRONTEND.md v2's "flash" posture conflicts with dense decision surfaces.
- There's no shared component library for v3.

**Pairs:** P4, P5, P6, P63.

**Requirements**
- **FR-1.1: tokens (§3.4)** as CSS variables and a Tailwind theme.
  - Light mode ships.
  - Dark tokens are defined but not rendered (D-PRD1).
  - `prefers-reduced-transparency` / low-memory fallback for materials.
- **FR-1.2: component library `ui-v3`** (§3.6) on web, with RN twins for mobile.
  - `/dev/ui`: an admin-only gallery route (noindex) rendering every component in every state (rest, hover, pressed, focus, disabled, loading, error, empty), both densities, and en/hi/te/ta.
- **FR-1.3: shells.**
  - Public header v3: mega-menu over the level-2 taxonomy; search field with mic slot; "Post a requirement" button.
  - Buyer and provider SideRail (desktop) / TabBar (mobile).
  - Badges from N2.
  - The avatar menu keeps: Profile, Switch role, Help, Density, Language, Sign out.
- **FR-1.4 (N2): `GET /api/v1/me/actions`.** Returns the viewer's counts and the first 10 items needing action. Each item: `kind`, `objectId`, `titleKey`, `action`, `dueAt`, `href`.
  - Derived from existing tables and the N23 selector.
  - Cached 30 s per user; invalidated on the viewer's own writes.
- **FR-1.5 (N3): universal search.**
  - `GET /api/v1/search/universal?q=` returns grouped results: services, providers, categories, plus `mine` (orders, requirements, invoices) when logged in, under RLS.
  - UI: ⌘K palette on desktop, full-screen sheet on mobile, with recent queries (on the device).
- **FR-1.6 (N33): `users.ui_density`**, `comfortable` | `compact`, null = the role default. Toggled in the avatar menu; respected by `DataTable`, `ResultRow` and the grouped lists.
- **FR-1.7: selects.**
  - Every `<select>` with ≤ 5 options becomes a `SegmentedControl` or chip group.
  - Every larger one becomes a `Picker` sheet.
  - A new ESLint rule, `amclub/no-raw-select`, fails CI on a raw `<select>` outside `ui-v3/Picker`.
- **FR-1.8: FRONTEND.md becomes v3**, per §3 of this PRD, in the same PR as the tokens.
- **FR-1.9: Playwright fixtures** log in as buyer, provider and admin; axe runs on every logged-in shell page.

**UI: desktop buyer shell**
```
┌────────────┬──────────────────────────────────────────────────────────────────────────────┐
│ ◆ AMClub   │  Home                                              ⌘K Search…   🔔 3   (R)  │  ← translucent bar
│            │                                                                              │
│ ⌂ Home     │  Good morning, Ravi                                          (Large title)   │
│ ⌕ Search   │                                                                              │
│ ▤ Require- │  NEEDS YOUR ACTION · 3                                                       │
│   ments  4 │  ┌─────────────────────────────────────────────────────────────────────────┐ │
│ ▣ Orders 1 │  │ 4 quotes waiting — GST filing FY 25-26                    Compare  ›    │ │
│ ♡ Saved    │  │ Accept delivery — Trademark class 35 · by Fri 3 Oct         Review ›    │ │
│ ─────────  │  │ Share 2 documents — Udyam registration                      Upload ›    │ │
│ ▦ Invoices │  └─────────────────────────────────────────────────────────────────────────┘ │
│ ◎ Profile  │                                                                              │
└────────────┴──────────────────────────────────────────────────────────────────────────────┘
```
(Section headers render in Footnote style and sentence case per §3.7; they're shown in capitals here only for the ASCII drawing.)

**UI: public header, desktop**
```
◆ AMClub   Services ▾   [⌕ Search services or providers…            🎙]   Post a requirement   EN ▾   Sign in
           └ mega-menu: 8 columns × top 3 services + "All services" — nothing else
```

**Data and API.**
- `users.ui_density` (migration; rollback: drop column).
- N2 and N3 endpoints (Zod schemas in `packages/shared`).
- No money paths touched.

**Events:**

| Event | Properties |
|---|---|
| `nav_item_clicked` | `shell`, `item` |
| `command_search_opened` | |
| `universal_search_performed` | `q_len`, `groups` |
| `density_changed` | `value` |
| `megamenu_item_clicked` | |

**Flag:** `exp_v3_shell`.

**Acceptance**
- Every buyer and provider page can be reached from the nav without dashboard tiles.
- Badge counts equal fixture truth for 6 seeded states.
- No raw `<select>` (lint).
- axe: 0 serious/critical on the shells.
- Lighthouse ≥ 90 on `/`, `/services` and a provider page.
- The `/dev/ui` gallery screenshot set is reviewed at 360×800 @3x and 1440×900.
- FRONTEND.md v3 is merged.

**RICE:** R 1.0 · I 1 · C 0.7 · E 4 → **0.18**. It's an enabler: every later epic builds on it.

---

### E2: Discovery (search, filters, level-2 pages, shortlist compare)

**Problem.**
- Filters are dropdowns that appear only after a query.
- There's no category filter, and only 10 states (fixed in E0).
- There's no voice search.
- A failed search dead-ends at signup.
- There's no dense list view, no relevance feedback, and no way to compare providers before an RFQ.

**Pairs:** P5, P7, P8, P9, P10, P11, P12, P13, P14.

**Requirements**
- **FR-2.1 (N4): search API v2.** `/api/v1/catalog/search` gains these parameters:
  - `category`, `service` (level 2), `state` (37), `city`;
  - `credential` (verification kind), `responseMaxHours`, `deliveryMaxDays`, `priceBand`;
  - existing: `minRating`, `language`, `verifiedOnly`.
  - **Sort:** `best` (default: full-text rank × trust, never paid), `rating`, `price_asc`, `price_desc`, `fastest`, `newest`.
  - **The response adds:** facet counts per value (desktop rail) and `display` prices (N16).
- **FR-2.2: filter UI.**
  - **Mobile:** `FilterChipBar` with ≤ 5 chips — Verified · ≤ 7 days · Price · 4★+ · Language — plus "More" → `FilterSheet` with the rest.
  - **Desktop ≥ 1280:** a collapsible left facet rail with counts. Sort sits top right; results count top left.
  - Filters show **before** a query on category pages.
- **FR-2.3: sibling chips** from the level-2 taxonomy, and level-2 landing pages (`/services/[category]/[service]`). The landing shows:
  1. a hero line;
  2. a dense **provider comparison table** for that service: provider, credential, from-price + GST, delivery, on-time (D1), response, rating;
  3. the result grid.
- **FR-2.4: grid / list toggle.**
  - List = `ResultRow`: logo · name + credential · rating (n) · stat · delivery · response · price + GST · save. Compact density.
  - Default: grid on mobile, list on desktop for returning users (remembered).
- **FR-2.5 (N5): voice search.**
  - A mic in `SearchField`.
  - Uses the Phase 8b pipeline with a new `mode=query`: speech → English query + detected language. Same consent note; no audio retained.
  - Stub mode keyless.
  - Result pages show "You said: …" as an editable chip.
- **FR-2.6 (N6): relevance feedback.**
  - A "Did you find what you need? Yes / No" row after the first results page. "No" asks one optional reason chip: not relevant / too expensive / too slow / not in my state.
  - Stored in a new table `search_feedback`: query text, parsed filters, result ids shown (the first 24), helpful, reason, `user_id` nullable, `created_at`. RLS: no client reads.
  - Also sent to PostHog.
- **FR-2.7 (N7): weak or zero results.**
  - Weak = < 3 results, or every result below the rank threshold.
  - Show an inline card: "Get quotes for '<q>' from up to 7 verified providers in <state>. Your number stays hidden." [Post requirement], prefilled through N20 (`?q=&category=`).
- **FR-2.8 (N8): recently viewed.**
  - The last 20 provider/package views in `localStorage`, synced to `recent_views` for logged-in users (upsert, keep 20).
  - Shown on home, in the search sheet's empty state, and on the zero-result page.
- **FR-2.9 (N34): shortlist compare.**
  - A "Compare" checkbox on cards/rows, up to 4. A tray docks at the bottom with the count and "Compare".
  - `/compare?items=` renders `CompareTable v3`, rows grouped as:

    | Group | Rows |
    |---|---|
    | Price | from-price + GST, tiers |
    | Time | delivery |
    | Trust | verification, stats, rating (n), orders |
    | Terms | revisions, refund line |
    | Actions | view, buy, post requirement |

  - Pre-RFQ only: no quotes, no chat.
- **FR-2.10: paging.** Load-more on mobile (24 per page); numbered pages on desktop.

**UI: mobile search results**
```
┌────────────────────────────────────────┐
│ ◀  Search                              │ ← material bar
│ ┌────────────────────────────────────┐ │
│ │ ⌕ GST registration              🎙 │ │
│ └────────────────────────────────────┘ │
│ Tax & accounting › GST filing  ITR  Audit   ← sibling chips (scroll)
│ [✓ Verified] [≤ 7 days] [₹ Any] [4★+] [⋯ More]
│ 128 providers              Best match ⇅ │
│ ┌────────────────────────────────────┐ │
│ │ (logo) Sharma & Co. ✓      ♡  ☐   │ │  ☐ = add to compare
│ │ ICAI member · Hyderabad            │ │
│ │ ★ 4.8 (126) · 96 % on time (48)    │ │
│ │ GST registration — proprietorship  │ │
│ │ 3 days · replies ~2 h · active     │ │
│ │ ₹1,499 + GST                       │ │
│ └────────────────────────────────────┘ │
│ … 23 more · Load more                  │
│ Did you find what you need?  Yes  No   │
└────────────────────────────────────────┘
      ┌──────────────────────────────┐
      │ Compare (2)            View › │ ← tray appears at 1+
      └──────────────────────────────┘
```

**UI: desktop, list view**
```
┌ Filters ───────────┐  128 providers · GST registration                        Best match ⇅  ▦ ▤
│ Category           │ ┌──────────────────────────────────────────────────────────────────────────┐
│ ● Tax & accounting │ │   Provider               Rating      On time   Replies  Delivery  Price  │
│ Service            │ │ ☐ (◻) Sharma & Co. ✓     4.8 (126)   96 % 48   ~2 h     3 d   ₹1,499+GST │
│ ☑ GST registration │ │     ICAI · Hyderabad                                              ♡      │
│ State              │ │ ☐ (◻) Rao Associates ✓   4.6 (54)    91 % 22   ~5 h     4 d   ₹1,299+GST │
│ ☑ Telangana   (64) │ │     ICAI · Warangal                                               ♡      │
│ Credential         │ │ ☐ (◻) TaxEase ✓          4.9 (12)    — n<10    ~1 h     2 d   ₹1,999+GST │
│ ☐ ICAI        (88) │ │     GSTP · Hyderabad                                              ♡      │
│ Delivery ≤ 7 days  │ └──────────────────────────────────────────────────────────────────────────┘
│ Price  ◯────●───◯  │   1  2  3  4  5  ›
└────────────────────┘
```

**Data and API.**
- Search v2 parameters.
- Tables `search_feedback` and `recent_views`, both RLS'd:
  - `search_feedback`: service role writes only.
  - `recent_views`: the owner reads and writes.
- Taxonomy content: level-2 services for 8 categories. That's a content task: 24–40 services, with en/hi/te/ta names.
- `categories.parent_id` is used from here on.
- **Rollback:** the flag reverts the UI; the tables are additive.

**Events:**

| Event | Properties |
|---|---|
| `search_performed` | `q_len`, `filters`, `sort`, `results`, `view` |
| `search_filter_changed` | `filter`, `value` |
| `search_voice_used` | `lang`, `ok` |
| `search_feedback_given` | `helpful`, `reason` |
| `search_zero_results` | |
| `search_to_requirement_clicked` | |
| `recent_view_opened` | |
| `shortlist_added` | `count` |
| `compare_opened` | `n` |
| `service_page_viewed` | `service` |

**Flag:** `exp_v3_search`. Voice search is also flag `voice_search_enabled` (default on only after the eval below).

**Acceptance**
- Every filter round-trips through the URL (shareable) and back.
- Facet counts equal fixture truth.
- Voice search: the stub works keyless; with keys, an eval of 30 recorded queries (te/hi/en, code-mixed) yields the correct category in ≥ 85 %. Measured before `voice_search_enabled` goes on.
- The zero-result flow carries the query into the requirement form (Playwright).
- Shortlist compare renders 4 providers with identical row sets.
- Sort `best` never uses a paid signal (unit test on the ranking function).
- p75 LCP on `/services?q=` < 2.5 s (4G profile).

**RICE:** R 0.8 · I 2 · C 0.7 · E 4 → **0.28**.

**As built (E2a: search v2, filters, feedback, weak results).** E2 ships as two PRs: E2a is this one; E2b adds the service pages, shortlist compare, recently viewed and voice search.
- **Level-2 services** are the shared `SPECIALIZATIONS` vocabulary (40 services, already the voice parser's list) plus `packages.service_slug`. `categories.parent_id` stays unused, so RFQ fan-out, commission and `provider_categories` keep the eight-category graph.
- **Two new RPCs.** `search_packages_v2` and `search_facets_v2` arrive in migration 0051, and v1 is untouched. The app falls back to v1 on any v2 error, so a deploy ahead of the migration keeps search working without facets.
- **Facets** are disjunctive: each facet ignores its own filter.
- **Price** bands and price sorts use the price before GST, after the package discount.
- **"best" sort** is text rank × weighted rating × a verification boost. A shared test reads the SQL block and fails on any other input.
- **Paging.** The URL carries `page` (`offset` still parses). Phones use `page=N&more=1` for load-more, showing pages 1..N, capped at 4.
- **List rows** leave out the save heart: one saved-state fetch per row is too costly. Save stays on the card and the provider page, and E2b's compare checkbox covers shortlisting.
- **The grid/list choice** is remembered in the `amc_search_view` cookie.

**As built (E2b: service pages, compare, recently viewed, voice search).**
- **Services on packages.** The wizard offers the service chips of the chosen category when the flag is on. The routes refuse a service from another category (`invalid_service`), and `service_slug` is written only when sent.
- **Service pages.** `/services/[category]/[service]` covers all 40 services and 404s while the flag is off. The provider table shows up to 8 providers, each with their lowest price for the service. Sibling chips link every service page to the others.
- **Compare.** The shortlist lives on the device (`localStorage`, at most 4). The toggle sits beside the card link, never inside it. `/compare` is `noindex` and has 10 rows in 4 groups for every column, plus the actions.
- **Recently viewed.** It is a device list merged with `recent_views` (migration 0052, owner-only RLS, newest 20) when signed in. It shows on the buyer home, in the ⌘K empty state and on zero-result pages.
- **Voice search** reuses `/api/v1/rfq/voice-parse` with `mode=query`, behind the same limiters. It needs the search flag plus `agent_settings.voice_search_enabled` (default off until the 30-query eval). A signed-out tap goes to sign-in. A voice search lands on `?query=…&voice=1`, which shows "You said".

---

### E3: Trust made visible

**Problem.** We compute outcome data and verify identities, but buyers see initials, chips without dates, and a response time. "Top Rated" was dead code (removed in E0).

**Pairs:** P15–P22.

**Requirements**

- **FR-3.1: ResultCard v3.** These elements, in this order, and nothing else:
  1. logo (initials fallback);
  2. name + verified tick;
  3. credential line;
  4. ★ rating (n) + **one** measured stat;
  5. package title;
  6. chips: delivery · replies ~Xh · active this week;
  7. PriceBlock v3 ("₹X + GST");
  8. save ♡;
  9. compare ☐.

  No contact CTA, no paid rank. Which stat shows: on-time % if n ≥ gate, else repeat-buyer % if n ≥ gate, else nothing.

- **FR-3.2: profile header.**
  - **Identity row:** logo, name, credential, city, "since 2024".
  - **4 `StatTile`s:** rating (n) · on-time % (n) · replies ~Xh · orders completed.
  - **`TrustPanel`:** `VerificationChecklist` (≤ 5 lines, "Show all"), next available start, active this week.
  - **Section tabs:** Packages · About · Reviews · Credentials.
  - **Sticky bar (mobile):** "From ₹X + GST · See packages".

- **FR-3.3 (N9): public measured stats.**
  - **Where computed:** the existing nightly `cron/provider-stats`, into a new table `provider_public_stats` (one row per provider, no id exposure beyond the provider).

  | Column | Definition |
  |---|---|
  | `completed_orders` | |
  | `on_time_pct`, `on_time_n` | first delivery ≤ `due_at` over delivered orders, 180-day window |
  | `repeat_buyer_pct`, `repeat_n` | buyers with ≥ 2 paid orders ÷ distinct buyers, 365 days |
  | `response_rate_pct`, `response_n` | matched RFQs quoted or declined-with-reason within 48 h ÷ matched, 90 days |
  | `computed_at` | |

  - **Sample gates** are registered settings: `public_stats_min_n` (default 10) and `public_stats_enabled` (default false).
  - **Never exposed:** the composite `score`, factor weights or ranks. The `SCORE_FIELD_NAMES` privacy test is extended with an allow-list of exactly these public field names.
  - **Requires:** D1 approval and an **ADR-010 amendment** ("individual measured stats public above gates; composite never").

- **FR-3.4 (N10): verification evidence.**
  - **New columns on `provider_verifications`:**
    - `method`: `api` | `manual` | `vendor`;
    - `verified_at`, `source` (e.g. "GST portal via <vendor>", "ICAI member directory, manual"), `expires_at` (nullable);
    - `evidence_hash` (nullable).
  - **Backfill** from existing rows: method by current flow; `verified_at` = row `updated_at`.
  - **Checklist line format:** "✓ GSTIN · checked with the GST portal · 12 Sep 2026".
  - **Nightly GSTIN re-check (F4):**
    - flags cancelled or suspended GSTINs to ops (audit row + admin banner);
    - never auto-suspends;
    - registered setting `gstin_recheck_enabled`.

- **FR-3.5: firmographics.** "Since <Mon YYYY>" from `created_at`; "Years in practice: 3–9" from the wizard band; languages spelled out (not codes).

- **FR-3.6 (N11): activity and availability.**
  - **Activity:** write `users.last_seen_at` on authenticated API activity, throttled to once per 15 minutes per user (server middleware; no client beacon). "Active this week" when ≤ 7 days.
  - **Availability:** `provider_profiles.next_available_on` (date, provider-set, optional).
    - Otherwise derived: today, if active orders < `capacity_slots` (provider setting, default 5); else the earliest `due_at` among active orders.
    - Shown as "Next available: Mon 29 Sep".
    - `capacity_paused` shows "Not taking new work".

- **FR-3.7 (N12): provider media.**
  - Logo upload in `/partner/profile` (1:1 crop, JPEG/PNG/WebP ≤ 2 MB in, stored ≤ 200 KB, served as AVIF/WebP at 48/96/192 px).
  - Moderation: new logos go into the admin verification queue; they show once approved.

- **FR-3.8 (N13): reviews v2.**
  - `GET /api/v1/providers/[slug]/reviews?cursor=`.
  - A histogram (5 bars).
  - A "Repeat buyer" marker, server-derived: the buyer has ≥ 2 paid orders with this provider. The buyer's identity is never exposed.
  - Provider replies stay.
  - Sub-scores (quality / communication / timeliness) are a later schema change, gated on review volume.

- **FR-3.9: AI review summary.**
  - Designed slot, dark (`agents_enabled.review_summary`), shown when reviews ≥ 20.
  - Every bullet must cite review ids.
  - Uses the output validator.
  - Registered as a new agent setting.

**UI: provider profile, mobile**
```
┌────────────────────────────────────────┐
│ ◀                           ♡   ⤴      │
│ (logo)  Sharma & Co.  ✓                │
│         Chartered accountants          │
│         Hyderabad · since Mar 2024     │
│ ┌────────┬────────┬────────┬────────┐  │
│ │ 4.8 ★  │ 96 %   │ ~2 h   │ 214    │  │  ← StatTiles (tabular)
│ │ 126    │on time │replies │ orders │  │
│ │ reviews│ 48 ord.│        │ done   │  │
│ └────────┴────────┴────────┴────────┘  │
│ Verified by AMClub                     │
│ ✓ GSTIN · GST portal · 12 Sep 2026     │
│ ✓ ICAI membership · manual · 3 Sep     │
│ ✓ Bank account · penny drop · 12 Sep   │
│   Show all 5 ›                         │
│ Next available: Mon 29 Sep · active    │
│ [Packages] About  Reviews  Credentials │
│ ┌────────────────────────────────────┐ │
│ │ GST registration        from ₹1,499│ │
│ │ Basic · Standard · Premium   + GST │ │
│ └────────────────────────────────────┘ │
│┌──────────────────────────────────────┐│
││ From ₹1,499 + GST     See packages  ││ ← sticky material bar
│└──────────────────────────────────────┘│
└────────────────────────────────────────┘
```

**Data and API**
- **Migrations:**
  - `provider_public_stats` (new, RLS: public read of approved rows, service role write);
  - `provider_verifications` columns;
  - `provider_profiles.next_available_on`, `capacity_slots`;
  - the logo moderation state.
- **Rollback:** additive; flags off.
- **API:**
  - The profile and search payloads gain `stats` (gated) and `verification[]` (method, date).
  - Reviews become cursor-paginated.

**Events:**

| Event | Properties |
|---|---|
| `provider_profile_viewed` | `source`. Also captured server-side for N29 |
| `trust_panel_expanded` | |
| `verification_item_opened` | `kind` |
| `reviews_loaded` | `page` |
| `stat_tile_info_opened` | `stat` |

**Flags:** `exp_v3_trust`; `public_stats_enabled` (D1).

**Acceptance**
- The privacy test proves no score field reaches any buyer-reachable payload, and that exactly the allow-listed stats do (only when enabled and above the gate).
- Stats equal fixture truth (rig: seed 12 orders, 11 on time → "92 %" with n = 12).
- Every verified kind shows method + date.
- `last_seen_at` is written ≤ 1 per 15 min per user (unit test on the throttle).
- Uploaded logos appear only after approval.
- Reviews paginate correctly past 10.

**RICE:** R 0.9 · I 2 · C 0.7 · E 4 → **0.32**.

---

### E4: Packages and honest pricing

**Problem.** One package per page, no tiers, no "choose this if…", no add-ons (E12), no refund line, no government disclaimer, and prices computed on the client.

**Pairs:** P3, P23–P26.

**Requirements**

- **FR-4.1 (N14): package tiers.**
  - **New table `package_groups`:**

    | Column | Purpose |
    |---|---|
    | `id`, `provider_id`, `category_id` | |
    | `service_slug` | level-2 service |
    | `title_i18n` | |
    | `compare_rows` | jsonb: `[{key, label_i18n}]`, ≤ 12 rows |
    | timestamps, `deleted_at` | |

  - **New columns on `packages`:**
    - `group_id` (nullable);
    - `tier`: `basic` | `standard` | `premium` (nullable);
    - `ideal_for_i18n` (the "Choose this if…" line, ≤ 90 characters);
    - `compare_values` (jsonb keyed by the group's `compare_rows`).
  - **Backfill:** every existing package gets no group, so the single-package page renders exactly as today.
  - **PackageWizard:** "Offer tiers?", with a guided 3-column editor and a live preview.
  - **Rollback:** the columns are nullable; the flag off hides tier UI.

- **FR-4.2: package page v3.**
  - **Desktop:** main column (title, provider line, tier matrix, included/excluded, deliverables, "what we'll need", FAQ) + a **sticky buy box**:

    | Buy box, top to bottom |
    |---|
    | tier tabs |
    | price equation |
    | delivery / revisions |
    | "Choose this if…" |
    | Buy now |
    | refund line |
    | government line |

  - **Mobile:** tier tabs under the title, the matrix swipes 2 tiers at a time, and a sticky buy bar showing the selected tier's total.

- **FR-4.3 (N16): server price display.**
  - Every catalog, package and checkout payload carries `display`: `{ taxablePaise, gstPaise, totalPaise, discountPaise, itcPaise? }`.
  - Computed by `computeOrderAmounts` on the server (no coupon; `itcPaise` = GST when the viewer has a valid GSTIN).
  - `PriceBlock v3` renders **only** these.
  - A unit test forbids arithmetic on `*Paise` in `components/**` (AST lint rule `amclub/no-client-money-math`).
  - **Formats:**
    - cards: "₹1,499 + GST";
    - detail: "₹1,499 + 18 % GST = ₹1,768.82";
    - with GSTIN: "…· claim ₹269.82 as ITC".

- **FR-4.4: refund line.** One i18n string summarising the policy ("Full refund before work starts · 50 % while in progress · disputes after delivery") + a "Refund policy" link. On the buy box and at checkout.

- **FR-4.5 (N17): `categories.govt_dependent` (bool) + `packages.govt_dependent_override` (nullable).**
  - When true: "Approval depends on the government portal. We can't guarantee it, and your provider's clock pauses while the portal is processing."
  - The copy links to the existing `external_wait` behaviour explanation.

- **FR-4.6: "Most chosen" label.** Only when computed from paid orders (tier share ≥ 50 % with n ≥ 10). Never provider-set.

**UI: package page, desktop**
```
Services › Tax & accounting › GST registration
GST registration                                                 ┌──────────────────────────────┐
Sharma & Co. ✓ · 4.8 (126) · 96 % on time                        │ [ Basic ][Standard][Premium] │
                                                                 │  ₹2,999 + 18 % GST           │
Compare tiers                                                    │  = ₹3,538.82                 │
┌──────────────────────┬──────────┬──────────┬──────────┐        │  2 days · 2 revisions         │
│                      │  Basic   │ Standard │ Premium  │        │  Choose this if: you also     │
│ GSTIN + certificate  │    ✓     │    ✓     │    ✓     │        │  need Udyam this week         │
│ Udyam registration   │    —     │    ✓     │    ✓     │        │ ┌──────────────────────────┐ │
│ 12 months of filing  │    —     │    —     │    ✓     │        │ │        Buy now           │ │
│ Dedicated expert     │    —     │    ✓     │    ✓     │        │ └──────────────────────────┘ │
│ Delivery             │  3 days  │  2 days  │  2 days  │        │  Money held until you accept │
│ Price + GST          │  1,499   │  2,999   │  5,499   │        │  Full refund before work     │
└──────────────────────┴──────────┴──────────┴──────────┘        │  starts · Refund policy      │
                                                                 │  ⓘ Depends on GST portal     │
What's included · What you'll get · What we'll need · FAQ        └──────────────────────────────┘
```

**Events:**

| Event | Properties |
|---|---|
| `package_viewed` | `tiers` |
| `tier_selected` | `tier` |
| `compare_matrix_viewed` | |
| `buy_now_clicked` | `tier`, `total_bucket` |
| `refund_policy_opened` | |

**Flag:** `exp_v3_packages`.

**Acceptance**
- Every price on web and mobile comes from `display` (lint + test).
- A single-package provider's page is byte-identical in content to today's except for the price equation and the refund line.
- Tier switching updates the buy box and sticky bar with no client arithmetic.
- `mart:static` stays green.
- The money-loop rig is unchanged and green.

**RICE:** R 0.8 · I 2 · C 0.7 · E 3 → **0.37**.

**As built (E4).**
- The tier editor is its own page, `/partner/listings/tiers`. Listings shows an "Offer tiers?" card once two listings share a category, and publishing from the wizard returns the provider to Listings. It uses the same three-column editor and live matrix preview.
- Each tier stays an ordinary package with its own price and checkout. A group only arranges packages.
- "Most chosen" counts a group's orders that were not cancelled or refunded (`ORDER_UNCHOSEN_STATUSES`). A tie never labels two tiers.
- ITC on public pages: the page is cached for everyone, so a small island asks `GET /api/v1/me/itc` (yes/no only, verified GSTIN). The figure it shows is the server's GST amount.
- The "no client money math" rule runs as `scripts/lint/client-money.ts` inside `pnpm lint` (a TypeScript-AST ratchet over `'use client'` files), not as a custom ESLint plugin.
- `computePricing` was removed from web and mobile.

---

### E5: Checkout v3

**Problem.** Checkout is already the fastest in the survey (one screen, 2 clicks), but it loses new buyers (fixed minimally in E0), hides the ITC value, and doesn't say what happens next.

**Pairs:** P1, P29, P30.

**Requirements**
- **FR-5.1 (N1): `InlineAuth` on the checkout page** for logged-out visitors: phone → OTP → name + business name → consent checkbox (the legal acceptance rows are written exactly as signup writes them), then the same page continues. No redirect.
- **FR-5.2: the breakdown** comes from `display` (N16): price, discount, taxable, GST 18 %, total. With a valid GSTIN, add a line: "Claim ₹X as input tax credit (GSTIN 36AA…Z5)".
- **FR-5.3: "What happens next"**, 3 lines generated from the state machine and settings:
  1. "<Provider> accepts within 24 h — or you're refunded in full."
  2. "You share: <requirements_template labels>."
  3. "Money released only when you accept the work."
- **FR-5.4: refund line** (FR-4.4).
- **FR-5.5: on success**, Paisa Moment (≤ 900 ms, skippable), then the order workspace with the NextStepBar on "Share requirements" (E8).

**UI: checkout, mobile**
```
┌────────────────────────────────────────┐
│ ◀  Checkout                            │
│ GST registration · Standard            │
│ Sharma & Co. ✓ · 2 days                │
│ ─────────────────────────────────────  │
│ Price                        ₹2,999.00 │
│ GST 18 %                       ₹539.82 │
│ Total                        ₹3,538.82 │
│ Claim ₹539.82 as input tax credit      │
│ (GSTIN 36AA…Z5)             Change ›   │
│ ─────────────────────────────────────  │
│ What happens next                      │
│ 1  Accepted within 24 h — or refunded  │
│ 2  You share: PAN, address proof       │
│ 3  Paid out only when you accept       │
│ Full refund before work starts ·       │
│ Refund policy                          │
│┌──────────────────────────────────────┐│
││          Pay ₹3,538.82               ││ ← sticky
│└──────────────────────────────────────┘│
└────────────────────────────────────────┘
```

**Events:**

| Event | Properties |
|---|---|
| `checkout_viewed` | `logged_in` |
| `checkout_inline_auth_started` | |
| `checkout_inline_auth_completed` | |
| `checkout_itc_shown` | |
| `payment_initiated` | |

Payment success stays a server event from the webhook.

**Flag:** `exp_v3_checkout`.

**Acceptance**
- Playwright: a logged-out new user completes payment without leaving `/app/checkout/[id]`.
- The totals equal the money-loop rig's expected amounts.
- ITC shows only with a checksum-valid GSTIN.
- Legal acceptance rows are written for inline signups (authz rig extended).

**RICE:** R 0.9 · I 1 · C 0.8 · E 1 → **0.72**.

**As built (E5).**
- **Own route group.** Checkout now lives in `(checkout)`. With the flag off, its layout behaves exactly like `(msme)`.
- **Guests.** With `EXP_V3_CHECKOUT=on` the middleware lets a signed-out visitor open `/app/checkout/<uuid>` only. Every other `/app` path is still walled. Guests only see this at "on", because there is no user to bucket.
- **Inline sign-in.** `AuthPanel` (phone or email OTP, or Google, with the consent checkbox) runs on the page. A new account then finishes name + business inline. The writes are the signup wizard's own `acceptLegalDocs(BUYER_LEGAL_DOCS)` then `POST /profile/msme`. The page refreshes into Pay.
- **ITC line.** It appears only for a checksum-valid profile GSTIN, which is shown masked.
- **Coupons.** When a coupon is applied, the breakdown comes from the coupon route's own `display` (priceDisplay with `extraDiscountPaise`). The v3 client does no money math.
- **Checkout is a focused task.** The v3 shell shows no rail or tab bar here, so the sticky Pay bar never overlaps them.
- **Success.** The Paisa Moment is capped at 900 ms (PaisaMoment `totalMs`; Mart keeps 1.4 s), then the order page opens. The NextStepBar arrives with E8.
- **Legal-acceptance check.** It lives in `verify-experience` e5, next to the flow it covers.

---

### E6: Requirements (RFQ) v3

**Problem.** The voice path is good. The typed path has no guidance while typing, two free-text boxes (fixed in E0), budget as two raw numbers, no suggested documents, no typed must-haves, and only 2 entry points.

**Pairs:** P31–P36.

**Requirements**

- **FR-6.1: layout, top to bottom.**
  1. voice hero (voice ring);
  2. "or type";
  3. category `Picker`, then service (level 2);
  4. title;
  5. template fields: `SegmentedControl` for ≤ 5 options, `Picker` for more;
  6. **one** free-text field;
  7. budget chips (bands, which write `budget_min/max`);
  8. needed-by date;
  9. must-haves;
  10. documents you'll likely need;
  11. `StrengthMeter`;
  12. the promise block;
  13. a sticky "Send to providers" button.

  At most 5 required fields per template, all marked.

- **FR-6.2 (N19): strength meter.**
  - A new shared function `rfqQualityScore(input)` in `packages/shared/src/rfq-quality.ts`, built on the **same rules** as the server pre-check, returns `{score 0–100, next: {field, gain}}`.
  - The server keeps calling the same rules, so there's one rule set, and a shared test asserts that client and server agree on 40 fixtures.
  - Shown as a thin emerald bar + "Add a deadline (+10)". No gamified colours.

- **FR-6.3 (N19): documents you'll likely need.**
  - **New table `service_document_requirements`:**

    | Column | Purpose |
    |---|---|
    | `category_slug` | |
    | `service_slug` | nullable |
    | `label_i18n` | |
    | `required` | bool |
    | `note_i18n` | |
    | `reviewed_by`, `reviewed_at` | CA/legal review stamp |

  - Seeded for the 8 categories. **The content needs a CA/lawyer review before `document_suggestions_enabled` turns on.**
  - Rendered as checkable suggestions; the ticked ones are saved in `rfqs.details.documents_expected`.
  - The model enrichment slot (AB-04 style: implied standards and documents) stays dark behind `agents_enabled.rfq_enrich` and only **adds** suggestions the buyer confirms.

- **FR-6.4 (N19 / F2): must-haves.** `rfqs.must_haves` jsonb, Zod `rfqMustHavesSchema`:
  - `credentials` (verification kinds);
  - `languages`;
  - `onSite` (bool);
  - `inStateOnly` (bool).
  - v1 shows them to providers.
  - **Using them in fan-out matching is a later decision (D-PRD6)**, because it changes who gets matched.

- **FR-6.5 (N38): quote SLA stat.** A nightly job computes the median first-quote time per category × state over 90 days. When n ≥ 20: "Quotes usually arrive within ~X h". Otherwise: "Quotes within 72 h".

- **FR-6.6 (N20): prefill contract.**
  - `rfqPrefillSchema` in shared: `q`, `category`, `service`, `from_package`, `from_provider`, `from` (the existing repost).
  - **Entry points:**
    - header button;
    - search zero/weak (N7);
    - provider profile (`from_provider` → prefill category only; see D-UX1);
    - package page ("Need something different?");
    - buyer home;
    - Buy again (N26).

- **FR-6.7: the promise block.** "Up to 7 verified providers in <State> · <SLA line> · Your number stays hidden until you pay." The state comes from the profile, with a "Change" link to the profile.

**UI: requirement, mobile**
```
┌────────────────────────────────────────┐
│ ◀  Post a requirement                  │
│ ┌────────────────────────────────────┐ │
│ │   ◉  Speak your requirement        │ │ ← voice ring (emerald/gold)
│ │   Telugu, Hindi or English · 30 s  │ │
│ └────────────────────────────────────┘ │
│            — or type —                 │
│ Category   Tax & accounting        ›   │
│ Service    GST filing              ›   │
│ Title *    GST returns FY 25-26        │
│ Filing *   [GSTR-1][3B][Annual][…]     │
│ Turnover * [<40L][40L–1.5Cr][>1.5Cr]   │
│ Budget     [<₹2k][₹2–5k][₹5–10k][?]    │
│ Needed by  Fri 10 Oct              ›   │
│ Must-haves ☐ ICAI  ☐ Telugu  ☐ On-site │
│ You'll likely need                     │
│ ☑ PAN  ☑ GST login  ☐ Sales register   │
│ Anything else?                         │
│ ┌────────────────────────────────────┐ │
│ └────────────────────────────────────┘ │
│ ▆▆▆▆▆▆▆░░░  Strong · add a document +5 │
│ Up to 7 verified providers in Telangana│
│ · quotes usually within ~9 h · your    │
│ number stays hidden until you pay      │
│┌──────────────────────────────────────┐│
││         Send to providers            ││
│└──────────────────────────────────────┘│
└────────────────────────────────────────┘
```

**Events:**

| Event | Properties |
|---|---|
| `requirement_form_started` | `entry` |
| `requirement_voice_used` | `lang`, `ok` |
| `requirement_strength_changed` | `bucket` |
| `requirement_document_toggled` | |
| `requirement_must_have_set` | |
| `requirement_submitted` | `score`, `required_filled`, `entry` |

**Flags:** `exp_v3_requirements`; `document_suggestions_enabled` (content review).

**Acceptance**
- Client and server scores agree (shared test).
- All 6 entry points prefill correctly (Playwright).
- ≤ 5 required fields in every template (seed test).
- The RFQ rig stays green; fan-out is unchanged (must-haves are display-only in v1).
- The document suggestions show a reviewed stamp before the flag turns on.

**RICE:** R 0.7 · I 2 · C 0.7 · E 3 → **0.33**.

**As built (E6).**
- **Strength meter.** `rfqQualityScore` (shared `rfq-v3.ts`) calls `rfqQualityPrecheck` itself, so client and server share one rule set. Each finding costs a fixed number of points; `RFQ_SCORE_PENALTY` sets them. The shared test checks agreement over 40 fixtures.
- **Service, must-haves and documents.**
  - The service and the expected documents ride in `rfqs.details` (`service_slug`, `documents_expected`). Must-haves go in `rfqs.must_haves` (migration 0053) and are written only when sent.
  - Fan-out never reads must-haves (D-PRD6). The check script shows the same match count with and without them.
  - The provider sees all three on their request page (`RfqExtrasV3`).
- **Document suggestions.** They come from `service_document_requirements`. The seeded rows are unreviewed. The form shows only rows with `reviewed_at` set, and only while `document_suggestions_enabled` is on. The reviewed date shows under the list.
- **Quote-time line.** `refresh_quote_sla_stats()` runs inside the existing nightly `cron/provider-stats`. It computes the median first-quote time per category × buyer state over 90 days. The form says "~X h" only when n ≥ 20.
- **Prefill contract.** `parseRfqPrefill` accepts `q`, `category`, `service`, `from_package`, `from_provider`, `from` and `entry`. The package page links "Need something different?". The header, search, provider and home entry points keep their existing links. Buy again arrives with E9.
- **Template fields.** Up to 5 options use a SegmentedControl; more use a Picker. The Send button is sticky above the phone tab bar via `--tabbar-h`, set by the v3 shell.

---

### E7: Quotes and compare v3

**Problem.** Compare is already our strongest screen. It needs: scope in the desktop table, the benchmark and reliability slots wired to their gates, and loss labels to feed the provider insights.

**Pairs:** P37, P38, P39, P41. Speed tiers (P40) are in E12.

**Requirements**

- **FR-7.1: `CompareTable v3`.**
  - Compact by default on desktop; sticky header and label column.
  - **Row groups:**

    | Group | Rows |
    |---|---|
    | Price | as quoted, GST state, normalised total |
    | Time | delivery, valid until |
    | Terms | advance, transport, **scope (now on desktop)** |
    | Provider | rating (n), stats (D1), orders, responds in |
    | Flags | |
    | Actions | |

  - Mobile stays as cards with the same groups.
- **FR-7.2:** benchmark line slot above the table (S3.2, dark until the volume gates), and a reliability sort option (dark until D1 and `reliability_rank_enabled`).
- **FR-7.3 (N22): loss labels.**
  - When a quote is accepted, every other open quote on the RFQ gets a `quote_events` row `lost` with `{price_delta_paise, days_delta}` against the winner.
  - Written in the same `finalizeQuoteAcceptance` pass. Idempotent: once per quote.
  - Feeds N29.
  - The buyer's decline reasons (existing enum) are aggregated alongside.
- **FR-7.4:** accept stays 2 clicks + confirm sheet; the Gold Stamp is ≤ 700 ms.

**UI: compare, desktop, Compact**
```
Compare quotes · GST returns FY 25-26                 Shortlisted only ☐     Sort: Normalised total ⇅
┌──────────────────────┬────────────────────┬────────────────────┬────────────────────┐
│                      │ Quote A            │ Quote B            │ Quote C            │
│                      │ Sharma & Co. ✓     │ Rao Associates ✓   │ TaxEase ✓          │
├ PRICE ───────────────┼────────────────────┼────────────────────┼────────────────────┤
│ As quoted            │ ₹4,500             │ ₹3,900             │ ₹5,200 incl. GST   │
│ GST                  │ + 18 %             │ not stated ⚠       │ included           │
│ Normalised total     │ ₹5,310  lowest     │ ₹4,602* ⓘ          │ ₹5,200             │
├ TIME ────────────────┼────────────────────┼────────────────────┼────────────────────┤
│ Delivery             │ 4 days             │ 6 days             │ 3 days  fastest    │
│ Valid until          │ Fri 3 Oct          │ Sat 4 Oct          │ Thu 2 Oct  soon ⚠  │
├ TERMS ───────────────┼────────────────────┼────────────────────┼────────────────────┤
│ Advance              │ 0 %                │ 50 % ⚠             │ 20 %               │
│ Scope                │ 12 returns + recon │ 12 returns         │ 12 returns + ITC…  │
├ PROVIDER ────────────┼────────────────────┼────────────────────┼────────────────────┤
│ Rating · on time     │ 4.8 (126) · 96 %   │ 4.6 (54) · 91 %    │ 4.9 (12) · n<10    │
├──────────────────────┼────────────────────┼────────────────────┼────────────────────┤
│                      │ [Accept & pay] ✕ ☆ │ [Accept & pay] ✕ ☆ │ [Accept & pay] ✕ ☆ │
└──────────────────────┴────────────────────┴────────────────────┴────────────────────┘
```

**Events:**

| Event | Properties |
|---|---|
| `compare_viewed` | `quotes` |
| `compare_sorted` | `key` |
| `quote_shortlisted` | |
| `quote_accepted` | |
| `quote_declined` | `reason` |
| `quote_lost_labelled` | server |

**Flag:** `exp_v3_compare`.

**Acceptance**
- `verify-rfq` gains criterion 5: accepting B labels A and C as `lost` with correct deltas, exactly once on replay.
- Scope visible on desktop.
- No money-path change.

**RICE:** R 0.5 · I 1 · C 0.8 · E 1.5 → **0.27**.

**As built (E7).**
- **Compare v3** (flag `compare`): the buyer RFQ page widens and `QuoteCompare` renders grouped rows (Price · Time · Terms · Provider · Flags, then Actions) with a sticky quote header and label column, scrolling inside its own container. Scope is a desktop row (clamped in Compact, "Read all"). Compact is the default density; Comfortable is one tap. Facts from code tag the cells (lowest total, fastest, ends soon, high advance). Below md the cards carry the same groups. Sort is a SegmentedControl (Total, Delivery, Rating, Response; Reliability only when S2.4 sends the reliability order). The benchmark line stays above the table.
- **Stats (D1).** Not shown: the Provider group carries rating (n), completed orders and response time only, until D1 and its ADR-010 amendment.
- **Loss labels (N22).** Shared `quote-loss.ts` (`quoteLossLabel`, `quoteNormalizedTotal` = the compare number = the checkout charge). `finalizeQuoteAcceptance` writes one `quote_events` `lost` row per auto-declined quote, `{v, accepted_quote_id, price_delta_paise, days_delta}` (mine − winner), through `labelLostQuotes`: best-effort, never throws, outside the money path; a replay of the winning order writes any missing label, and migration 0058's partial unique index `quote_events_lost_once` makes a second one impossible. 0058 also hides `lost` rows from the losing provider (the delta would rebuild the winner's price); provider insights (E11c) read the labels server-side and still return only n-gated aggregates. Labels are written while `compare` is live (0058 applied first).
- **Acceptance.** `verify-rfq` criterion 10 (this section's "criterion 5"): six labels with the shared deltas, none added on a signed webhook replay, a dropped label restored exactly once, and the provider cannot read its label. `verify-experience` e7: groups, desktop scope, GST states and totals, fact tags, cards.

---

### E8: Order workspace v3

**Problem.**
- One long page with 11 sections.
- The action is buried in a card.
- **No messaging after payment** (PRD M6), so coordination moves to phone calls, which is leakage.
- Providers don't see "payment secured".

**Pairs:** P42–P45 (P46 is ADR-011).

**Requirements**

- **FR-8.1 (N23): next action.**
  - `nextAction({status, role, facts})` in `packages/shared/src/order-next-action.ts` returns `{action, labelKey, dueAt?, consequenceKey?}`.
  - Unit-tested over every status in `ORDER_STATUSES` × {buyer, provider} × relevant facts:
    - requirements submitted?
    - revisions left?
    - dispute window open?
    - external wait?
  - Used by `NextStepBar`, N2 badges, N25 lists and notification copy.
  - One source of truth; no status literals outside `state-machines.ts` (rule 8).

- **FR-8.2: `NextStepBar`.**
  - A sticky material bar under the title with the one primary action and its deadline and consequence: "Accept delivery by Fri 3 Oct — after that it's accepted for you".
  - Secondary actions (revision, report a problem) sit in an overflow menu.

- **FR-8.3: `SectionTabs`:** Overview · Requirements · Work · Messages · Documents · Timeline.
  - **Overview:** status, money line, deadlines, next action.
  - **Work:** milestones with photos, deliverables.
  - **Timeline:** the Gold Thread.

- **FR-8.4 (N24): order messaging.**
  - A new `conversations.kind = 'order'` (or a table `order_messages` if the conversation model doesn't fit; decided in the implementation plan).
  - **Masking:** reuses `redactContactInfo` exactly like quote threads.
  - **Access:** RLS for the parties + admin. Attachments link to `order_documents`.
  - **Notifications:** in-app + WhatsApp template "New message on order #…", with no message content in the WhatsApp body.
  - **Lifetime:** open until 30 days after completion or resolution, then read-only.
  - **Agents:** agent reply-drafting slots stay dark.

- **FR-8.5 (N37): money line on the provider view.**
  - "Payment secured ✓ ₹X held by AMClub" while active.
  - After completion: "Payout scheduled for <date>", from the payout `scheduled_for` (T+2).
  - On hold: "Payout on hold: <reason>", with the reason from the existing hold reasons.

- **FR-8.6: disputes.** "Report a problem" stays quiet in the overflow and Overview, with the dispute-window deadline (ADR-014 §6).

**UI: order, mobile**
```
┌────────────────────────────────────────┐
│ ◀  Order A1B2                     ⋯    │
│ GST registration · Standard            │
│ ● In progress · due Thu 2 Oct          │
│┌──────────────────────────────────────┐│
││ Next: share 2 documents by today 6pm ││ ← NextStepBar (sticky)
││                          [ Upload ]  ││
│└──────────────────────────────────────┘│
│ Overview  Requirements  Work  Messages 2 Docs  Timeline
│ ─────────────────────────────────────  │
│ ₹3,538.82 paid · held until you accept │
│ Provider  Sharma & Co. ✓   replies ~2h │
│ Revisions 0 of 2 used                  │
│ Timeline                               │
│ ●━━━━●━━━━○────○────○                  │ ← Gold Thread
│ Paid  Accepted  Work  Delivered  Done  │
└────────────────────────────────────────┘
```

**Events:**

| Event | Properties |
|---|---|
| `order_viewed` | `status`, `role` |
| `order_next_action_clicked` | `action` |
| `order_tab_viewed` | `tab` |
| `order_message_sent` | `redacted`: bool |
| `order_message_read` | |

**Flag:** `exp_v3_orders`; order messaging is also `order_messaging_enabled`.

**Acceptance**
- `nextAction` has a test for every (status × role) pair.
- `verify-authz` gains order-messaging checks:
  - the other party can't read the thread;
  - phone and email are masked in the stored body;
  - no client can insert directly (the insert goes through the route).
- Money rigs unchanged and green.
- A WhatsApp notification never includes message text.

**RICE:** R 0.6 · I 2 · C 0.7 · E 4 → **0.21**.

**As built (E8a: next step, tabs, money line; messaging is E8b).**
- **Shared `order-workspace-v3.ts`.** `ORDER_TABS` / `parseOrderTab` (messages only while messaging is on), `nextStepTarget` (every self step maps to a workspace action or the tab that holds it; waits have no button), `goldThread` (the furthest step from status and events, plus the off-path branch), `providerMoneyLine` (N37). Typed maps over `ORDER_STATUSES` / `PAYOUT_STATUSES` (rule 8); tests cover every status.
- **`OrderWorkspace` v3** (flag `orders`, services orders): title + status + due date, the sticky `NextStepBar` (the shared `nextAction` label, deadline and consequence; the primary action only when `actionsFor` offers it; revision, "Report a problem", cancel and the government-wait toggle in the overflow), `SectionTabs` (Overview · Requirements · Work · Documents · Timeline; `?tab=` in the URL; every panel stays in the page, hidden). Overview: the money line, auto-accept, totals, revisions, the dispute-window deadline (ADR-014 §6), remind, refund, the revision note, dispute statements, review. Work: upload + deliver, deliverables, milestones. Timeline: the Gold Thread + the events. The v2 page renders the same blocks in its original order.
- **Money line.** Provider: "Payment secured ✓ ₹X held by AMClub" while active; then the payout row speaks (scheduled for, on its way, paid, on hold with the existing hold reasons, delayed). Buyer: "₹X paid · held by AMClub until you accept". Server paise only; `getOrderDetail` reads the payout for the provider only.
- **Not in E8a.** Mobile order screens (E14 parity), order messaging (E8b).
- **Acceptance.** `verify-experience` e8: the bar per role and status, five tabs with every panel present, `?tab=`, the Gold Thread, secured / scheduled / held lines, the buyer never sees the provider line. CI runs with `EXP_V3_ORDERS=on`.

**As built (E8b: order messaging, N24).**
- **Decision.** Order threads reuse `conversations` / `messages` with `context_type = 'order'` (one per order); no new table. Migration 0059 makes `conversations` read-only for parties (writes revoked; the service-role routes are the one writer for quote and order threads), adds admin / ops read on both tables and `messages_conversation_created_idx`.
- **Switch.** `agent_settings.order_messaging_enabled` (default off) AND the `orders` experience for the user; otherwise every route 404s and there is no Messages tab.
- **Routes.** `GET / POST /api/v1/orders/[id]/messages`, `POST …/read`: parties only (404 for anyone else), delegated agent tokens refused (reply drafting stays dark), 20 per minute. POST masks phone / email with `redactContactInfo` exactly like quote threads, attaches only this order's `order_documents` (≤ 3), and returns 409 `thread_read_only` 30 days after the order completes or is resolved (shared `orderThreadState`).
- **Notifications.** In-app + WhatsApp template `order_message` ("New message on order #…", the order number its only parameter; transactional for a party). Never the message text. One notice per 15-minute burst while unread.
- **UI.** The Messages tab (with the unread count) in the v3 order workspace: the masking note, the thread, attach order documents, read-only when closed; opening it marks the other party's messages read.
- **Acceptance.** `verify-authz` 7d: switch off → 404; stored body masked + flagged; the other party of the order reads it; another buyer / provider gets 404 and zero rows over PostgREST; no direct insert of a message or a conversation; no update; the notification never carries the text; read receipts.

---

### E9: Homes and retention

**Problem.**
- **The buyer home isn't a tool.** It has a greeting, a CMS banner, a completeness card, **5 tiles** and 3 recent orders.
  - It doesn't say what needs the buyer's action.
  - It doesn't offer anything to pick up.
  - The tiles repeat what the E1 navigation now holds.
- **Buying the same thing again starts from zero.** A monthly GST filing or a licence renewal is the most repeatable purchase we have, and the 90-day repeat target (≥ 25 %) depends on it.

**Pairs:** P12, P47, P48, P49, P67.

**Requirements**

- **FR-9.1 (N25): "Needs your action".**
  - Rows come from `GET /api/v1/me/actions` (N2, E1). **Order rows are computed by `nextAction` (N23)**, so the home, the order bar and notifications never disagree.
  - **Row kinds (buyer):**

    | Kind | Row | Source |
    |---|---|---|
    | `quotes_waiting` | "3 quotes on *GST returns FY 25-26* · from ₹5,310 all-in · compare" | open RFQ with submitted quotes; lowest normalised total from `compareQuotes` on the server |
    | `quote_expiring` | "Quote from Rao Associates expires Fri" | `valid_until` within 48 h |
    | `share_requirements` | "Share 2 documents · Udyam · today" | `nextAction` |
    | `accept_delivery` | "Accept delivery · auto-accepts Thu 2 Oct" | `nextAction`; the 72 h auto-accept deadline |
    | `answer_clarification` | "A provider asked a question on *Factory licence*" | `rfq_clarifications` (S1.3) awaiting the buyer |
    | `dispute_statement` | "Add your side of the dispute by Sat" | `dispute_statements` (S1.7) |

  - Ordered by deadline, then age. At most 5, then "See all".
  - Every row is one tap to the exact object and action (the §4.2 deep-link contract).
- **FR-9.2 (N8): "Pick up where you left off".**
  - Shows the newest requirement draft (drafts are Live), then the last 3 recently viewed packages or providers (N8, E2).
  - It's a horizontal shelf of compact cards. It's hidden when empty; no empty-state illustration.
- **FR-9.3 (N26): "Buy again" and "Repeat requirement".**
  - **Package orders** (completed): "Buy again" opens checkout v3 for the same package and tier **at today's server price**.
    - When the price changed: "₹1,000 last time · ₹1,180 now". This is the survey's stale-price risk, answered by showing both prices.
    - Package paused or deleted: "Find similar", which opens search prefilled with the service.
    - No new money path. It is an ordinary Buy-now order.
  - **Quote orders** (completed): "Repeat requirement" opens `/app/requirements/new?from=<rfq_id>` (the existing repost, N20).
    - Title, details, category, service, budget band and must-haves are copied; needed-by is cleared.
    - It fans out like any new requirement. Inviting the same provider directly is D-UX1 and is not in v3.
  - **The "Buy again" shelf:** up to 4 packages the buyer completed, the most recent first.
- **FR-9.4: the rest of the home.** Recent orders (3) and saved providers (4), each with "See all". The 5 tiles are removed. The completeness card stays (under 80 %), and dismissing it hides it for 7 days.
- **FR-9.5 (N45, gated by D-PRD5): "Coming due" and "What do I need?".** It pairs Top-10 #6 (the needs advisor) with foundation F7.
  - **Licences held (F7):** the buyer adds a licence (type, number, issued, expiry, authority, certificate upload). They can also confirm one from a completed registration order: the provider records the certificate's number and expiry on delivery.
  - **Reminders:** 60, 30 and 7 days before expiry. In-app plus a WhatsApp template ("Your FSSAI licence expires on 14 Nov. Renew with a verified provider: <link>"), sent once per threshold. The link opens the category.
  - **"What do I need?":** a routing checklist, not advice.
    - **Input:** the business profile (activity, state, size band from E0), shown back to the buyer for confirmation.
    - **Output:** "Businesses like yours in Telangana usually hold: …" from `obligation_rules`. Each rule has a source, a reviewed-by stamp and a date, and links to the category that provides it.
    - **Footer:** "This is a checklist, not legal advice. Confirm with a professional."
    - **No model in v3.** An agent slot stays dark.
  - **Gate:** a CA reviews 50 business profiles (F7's eval set). The checklist must reach ≥ 95 % precision before `obligations_enabled` turns on.

**UI: buyer home, mobile**
```
┌────────────────────────────────────────┐
│ Home                           🔔2  (R)│ ← large title; collapses on scroll
│ Good morning, Ravi                     │
│ NEEDS YOUR ACTION                    4 │
│┌──────────────────────────────────────┐│
││ 3 quotes · GST returns FY 25-26    › ││
││ from ₹5,310 all-in · compare by Fri  ││
││──────────────────────────────────────││
││ Accept delivery · Trademark filing › ││
││ auto-accepts Thu 2 Oct               ││
││──────────────────────────────────────││
││ Share 2 documents · Udyam   today ›  ││
│└──────────────────────────────────────┘│ ← inset grouped list
│ PICK UP WHERE YOU LEFT OFF             │
│ ┌──────────┐┌──────────┐┌──────────┐   │
│ │ Draft    ││ Sharma & ││ FSSAI    │   │
│ │ Factory  ││ Co. ✓    ││ Basic    │   │
│ │ licence  ││ 4.8 (126)││ ₹1,499 + │   │
│ └──────────┘└──────────┘└──────────┘   │
│ BUY AGAIN                              │
│ GST returns · Monthly   ₹1,180 now  [Buy]
│ COMING DUE                    (D-PRD5) │
│ FSSAI licence · expires 14 Nov  Renew ›│
│ RECENT ORDERS                  See all │
│ Home  Search  Requirements  Orders  Saved
└────────────────────────────────────────┘
```

**Data and API**
- `GET /api/v1/me/actions` gains the buyer kinds above. `actionItemSchema` is a Zod discriminated union in shared.
- `GET /api/v1/orders/[id]/buy-again` returns `{packageId, tier, displayThen, displayNow}` or `{searchHref}`. Read-only.
- **Gated by D-PRD5:**
  - `buyer_licences` (F7): RLS owner only; `deleted_at`.
  - `obligation_rules` (F7):
    - `activity`, `state`, `size_band`, `licence_type`, `category_slug`, `source_url`, `reviewed_by`, `reviewed_at`.
    - Anyone reads reviewed rows; admins write.
  - `cron/licence-reminders` runs daily. Its idempotency key is `licence_id:threshold`.
- **Rollback:** the tables are additive; flags off.

**Events**

| Event | Properties |
|---|---|
| `home_viewed` | `actions` (count) |
| `home_action_clicked` | `kind` |
| `home_pickup_clicked` | `kind`: draft / package / provider |
| `buy_again_clicked` | `price_changed`: bool |
| `requirement_repeated` | |
| `licence_added` | `source`: manual / order |
| `renewal_reminder_sent` | server; `threshold` |
| `obligation_checklist_viewed` | `rules` (count) |

**Flags:** `exp_v3_home`; `obligations_enabled` (D-PRD5).

**Acceptance**
- A seeded buyer with one fixture of each kind sees exactly those rows, in deadline order. Web and mobile read the same payload (a contract test on `/me/actions`).
- For every fixture order, the home row and the order's `NextStepBar` show the same action (they share `nextAction`).
- **Buy again** on a package whose price changed shows both prices, and checkout charges the new server price. `verify-money-loop` gains a criterion: a buy-again order is identical to a fresh Buy-now order at the same price.
- **Repeat requirement** creates a new RFQ and fans it out. The original is unchanged.
- **Reminders:** a licence expiring in 30 days sends one notification per threshold, exactly once, even when the cron runs twice.

**RICE:** R 0.7 · I 1 · C 0.8 · E 2.5 → **0.22**. The D-PRD5 part isn't scored until counsel and the CA answer.

**As built (E9a: home, buy again, repeat requirement).** E9 ships as two PRs: E9a is this one; E9b adds licences, reminders and the obligations checklist (D-PRD5, dark).
- **Action rows.** `actionItemSchema` is now a discriminated union.
  - `quotes_waiting` carries `fromPaise`, the lowest `compareQuotes` total.
  - The new `quote_expiring` kind is a submitted quote whose `valid_until` (an IST date, ending 23:59:59 IST) falls within 48 h. It carries `providerName`.
  - Order rows stay `order_action` with the N23 key (`share_requirements`, `review_delivery`, `dispute_statement`, `leave_review`), so the home and the order page read one rule.
  - The PRD's `answer_clarification` is the existing `clarification_question`.
  - The new data appears only while `home` is on for the user, so E1's badges are unchanged with the flag off.
- **Buy again.**
  - `GET /api/v1/orders/[id]/buy-again` is read-only and returns one of three kinds:
    - `package`: `displayThen` from the order's stored amounts (`orderPriceDisplay`, coupon included) and `displayNow` from `priceDisplay` today.
    - `similar`: the package, its provider or its capacity is paused or gone. It links to search prefilled with the category and service.
    - `repeat`: a quote order.
  - Buying is an ordinary checkout. `verify-money-loop` checks that a buy-again checkout session is identical to a fresh Buy-now session at the new price.
  - `GET /api/v1/me/buy-again` serves the shelf (up to 4 packages, one row per package, newest first) to web and mobile.
  - Finished statuses are `ORDER_REPEATABLE_STATUSES` (completed, reviewed).
- **Repeat requirement.** It uses the existing repost, `/app/rfq/new?from=<rfq>&entry=buy_again`. With E6 on, the repost also copies the service (`details.service_slug`), the budget band (`budgetBandOf`) and the must-haves. Needed-by stays cleared. The page itself stays `/app/rfq/new`; the `/app/requirements/*` rename belongs to the E1 IA work.
- **Home.**
  - Sections: Needs your action (≤ 5, "See all" → `/app/actions`), Pick up where you left off, Buy again, the CMS banner, recent orders (3) and saved providers (4).
  - The pick-up shelf is client-side because the requirement draft lives on the device (`amclub_rfq_draft`) and the recent items merge local and account lists.
  - Dismissing the completeness card hides it for 7 days on this device.
  - The five tiles are gone. Help and Assistant stay as two small links when their agents are on.
  - A new buyer with no orders and no actions sees one card: Explore services or Post a requirement.
- **Order page.** A finished services order shows Buy again, Repeat requirement or Find similar.
- **Mobile.** `/profile/me.homeV3Enabled` turns on `HomeV3Block`, which shows Needs your action and Buy again from the same two payloads as web.

**As built (E9b: licences, reminders, "What do I need?"; dark, D-PRD5).**
- **Switch.** Everything is dark behind `agent_settings.obligations_enabled` (registered, default off): the pages, `/api/v1/me/licences*`, `/api/v1/me/obligations`, `/api/v1/orders/[id]/licence-facts` and the cron. Turn it on only after D-PRD5 and the CA's ≥ 95 % precision check.
- **Tables (migration 0054).**
  - `buyer_licences`: owner-only RLS; soft delete (no DELETE grant); one licence per order.
  - `order_licence_facts`: service role only.
  - `licence_reminders`: its primary key `(licence_id, threshold_days)` is the idempotency key `licence_id:threshold`.
  - `obligation_rules`: anyone reads *reviewed* rows; writes are service-role. The seed is unreviewed.
- **Licence types.** The 11 types in shared `LICENCE_TYPES` each route "Renew" to the category (and service) that provides them. A shared test checks that the migration's three CHECK lists match the code.
- **Reminders.**
  - `cron/licence-reminders` runs daily at 02:30 UTC (08:00 IST). It claims the ONE due threshold (`dueReminderThreshold`): a licence added with 5 days left gets only the 7-day reminder, and a lapsed one gets none.
  - It notifies in-app plus WhatsApp template `licence_renewal_due` (opt-in gated; listed in PRE_LAUNCH_CHECKLIST).
  - A second run sends nothing. The admin heartbeat is `licence-reminders`.
- **From an order.** The order's provider records the certificate (type, number, dates, authority) from the work stage on. The buyer confirms it into a licence (`source = 'order'`) on the finished order page. There is no auto-creation.
- **Certificate.** Stored in the private bucket `licence-certificates` (5 MB; images / PDF). The owner gets a 15-minute signed link; anyone else gets a 404.
- **"What do I need?"**
  - `/app/obligations` shows the business facts (activity, state, size band) back for confirmation, with an Edit link.
  - It lists the CA-reviewed rules that match (null = any; the most specific rule wins; an unknown fact never matches a rule that sets it). Each rule shows its source, reviewer and date, "You have this" or "Find a provider", and the disclaimer.
  - No model; the agent slot stays dark.
- **Home.** With the switch on, a "Coming due" section lists licences expiring within 60 days (Renew). With none, it offers "What do I need?".
- **Not in this PR.** There is no admin editor for `obligation_rules`: ops stamp `reviewed_by` / `reviewed_at` after the CA review, as with 0053's document list. Mobile screens for licences are not included.

---

### E10: Provider onboarding v3

**Problem.**
- **5 steps:** Contact · Business · KYC · Bank · Submit.
- **9 required inputs + 2 verifications**, rising to 18 with credential categories.
- **GSTIN verification fills only the legal name.** Yet the vendor response already carries the legal name, trade name, state, registration date and active status (`GstinVerifyResult`, `apps/web/lib/kyc/types.ts`).
- No per-step analytics, so we can't see where providers drop out.
- GST-exempt practices (many small CA, CS and consultant offices) can't join at all.
- Mobile opens the web wizard in a browser (native screens are E13).

**Pairs:** P50, P51, P52.

**Requirements**

- **FR-10.1: "What you'll need", before step 1.**
  - GSTIN (or PAN, if D3 passes).
  - Bank account number + IFSC.
  - For credential categories, the membership number (ICAI, ICSI, Bar Council…).
  - A logo (optional).
  - "About 10 minutes. We save as you go."
- **FR-10.2: 4 steps** in the `Stepper` (named steps, not dots). The draft saves on every step, as today.

  | Step | Contents |
  |---|---|
  | 1. Contact | Name (the phone comes from sign-in) |
  | 2. Business | **GSTIN first**, then the autofilled fields, primary category, states served |
  | 3. Credentials & bank | The credential number (credential categories only), bank account + IFSC; the holder name comes from bank verification |
  | 4. Review & submit | A summary with an Edit link per section; the legal acceptance |

  **≤ 7 inputs the provider types** for a non-credential category.
- **FR-10.3 (N27): GSTIN autofill.** On a successful verify:
  - **Legal name:** filled and locked. An admin can override it in the verification queue.
  - **Trade name:** filled into the display name, which stays editable.
  - **State:** filled from the response. It's also checked against the GSTIN's first 2 digits by a shared `stateFromGstin()`. A mismatch is flagged for the admin; it doesn't block the provider.
  - **Registration date:** suggests "in business since". Years in practice stays provider-entered.
  - **States served:** defaults to the GSTIN state.
  - **Active status:** an inactive or cancelled GSTIN blocks the step, with the reason shown.
  - **Address:** filled only if the vendor returns it. Today's Surepass mapping doesn't; check at build time.
  - Autofilled fields carry a caption, "From GST records".
- **FR-10.4 (N27c): step analytics and a drop-off nudge.**
  - PostHog events per step (below).
  - **The stall rule:** a draft untouched for 24 h triggers one WhatsApp template, "Your AMClub profile is 2 steps from done", deep-linked to the exact step.
    - Sent only to providers who opted in to WhatsApp.
    - At most 2 nudges per draft. They stop on submit.
    - Sent by the notification dispatcher (Phase 6). It's a template, not an agent.
  - **"Finish on WhatsApp"** appears as an option only when the S1.6 onboarding agent is on for the provider's cohort (`agents_enabled.onboarding`).
- **FR-10.5 (N27b, gated by D3 and ADR-XD "GST-exempt providers"): the PAN path.**
  - A link on step 2: "I don't have a GSTIN (turnover under ₹20 lakh)". It leads to PAN verification and an exemption declaration (text from counsel), and sets `provider_profiles.gst_registered = false`.
  - **ADR-XD must settle:**
    - **Invoices:** the provider's service invoice becomes a bill of supply with no GST; AMClub's commission invoice still carries GST.
    - **Money:** `computeOrderAmounts` gains a `gstApplicable` input, so display, checkout and payout agree. This needs a `verify-money-loop` criterion.
    - **Display:** "No GST charged"; the ITC line is hidden.
    - **E-commerce operator obligations:** TCS under GST §52 and anything notified under §9(5). This is a CA question.
    - **Categories:** credential services only. Mart sellers always need a GSTIN (unchanged).
    - **The threshold:** an annual self-declaration, and a prompt to add the GSTIN once the provider registers.
  - **Nothing is built** until D3 is yes and ADR-XD is accepted.

**UI: step 2, mobile**
```
┌────────────────────────────────────────┐
│ ◀  Join as a provider                  │
│ ①━━━②━━━③━━━④                          │
│ Contact Business Credentials Review    │
│ Business                               │
│ GSTIN                                  │
│ ┌──────────────────────────┐┌───────┐  │
│ │ 36AABCS1429B1Z5          ││Verify │  │
│ └──────────────────────────┘└───────┘  │
│ ✓ Active · verified just now           │
│ Legal name     Sharma & Co. LLP     🔒 │
│ Display name   Sharma & Co.            │
│                From GST records        │
│ State          Telangana               │
│ Since          Mar 2016                │
│ Primary category   [ Tax & accounting ▾ ]
│ States served  [Telangana ✕] [+ Add]   │
│ I don't have a GSTIN ›        (D3)     │
│┌──────────────────────────────────────┐│
││             Continue                 ││
│└──────────────────────────────────────┘│
└────────────────────────────────────────┘
```

**Data and API**
- The `POST /profile/provider` payload is unchanged apart from the new optional autofilled fields.
- Shared `stateFromGstin()` + a test covering all 37 state codes.
- `onboarding_nudges` (`provider_id`, `step`, `sent_at`; service role only), for the 2-nudge cap.
- **Gated by D3:** `provider_profiles.gst_registered` (default true), `pan_verified_at`.
- **Rollback:** additive; the flag reverts to the 5-step wizard.

**Events**

| Event | Properties |
|---|---|
| `onboarding_step_viewed` | `step`, `category` |
| `onboarding_step_completed` | `step`, `ms` |
| `onboarding_gstin_autofilled` | `fields` (count) |
| `onboarding_abandoned` | server, from the stall rule; `step` |
| `onboarding_nudge_sent` | server; `step` |
| `onboarding_submitted` | `category`, `path`: gstin / pan |

**Flags:** `exp_v3_onboarding`; `pan_path_enabled` (D3).

**Acceptance**
- A stub GSTIN fills 4 fields. An inactive GSTIN blocks the step with the reason.
- A mismatched state code creates an admin flag, not a block.
- A non-credential category needs ≤ 7 typed inputs (a Playwright count).
- A draft stalled 24 h gets exactly one nudge. A second run of the cron sends none. Submitting stops further nudges.
- The admin verification queue shows the autofill source for each field.

**RICE:** R 0.7 · I 1 · C 0.9 · E 1.5 → **0.42**.

**As built (E10).**
- **Flag and entry.** `EXP_V3_ONBOARDING`. `/partner/onboarding` renders `ProviderWizardV3`: "What you'll need", then Contact · Business · Credentials & bank · Review & submit in the `Stepper`. `?step=` resumes at a step; the nudge links there. `/partner/signup` signs the applicant in and hands off to it.
- **Writes.** They are unchanged: `acceptLegalDocs(PROVIDER_LEGAL_DOCS)` → `POST /profile/provider`.
- **Typed inputs.** A non-credential category types 5: name, GSTIN, city (optional), account number and IFSC. The display name and state come prefilled; the category is picked.
- **GSTIN autofill.**
  - `verify-gstin` also returns `autofill` (shared `toGstinAutofill`): legal name, trade name, state, registration date, active status with its reason, and address when the vendor returns one.
  - The state comes from the vendor when it names one, else from `stateFromGstin()`. All 38 GST codes are mapped and tested.
  - A disagreement sets `stateMismatch`: an admin flag, never a block. An inactive GSTIN blocks Continue and shows the registry status.
  - The legal name is read-only once filled ("From GST records"); the admin can override it.
  - "In business since" is shown, not stored.
  - Surepass now reads `gstin_status` for active / inactive and passes `address` through when present.
- **"States served".** It stays the single profile state: the schema has no served-states list yet.
- **Admin queue.** Each pending application shows, per field, "From GST records" or "Typed by the provider". The comparison is against the applicant's latest successful `gstin_verifications` row.
  - The state check is shown as a warning when the GSTIN code differs from the saved state or the registry.
  - `POST /api/v1/admin/verifications/[id]/legal-name` overrides the locked legal name. It is audit-logged with the reason.
- **Stall nudge.**
  - Migration 0055: `provider_onboarding_progress` (one row per applicant, written on every step, `submitted_at` stamped on submit) and `onboarding_nudges` (PK `(user_id, nudge_no)`).
  - Hourly `cron/onboarding-nudges`: in-app plus the `onboarding_stalled` WhatsApp template. The dispatcher sends WhatsApp only to applicants who opted in.
  - At most 2 per draft, 24 h apart. None after submit, or once the applicant has a profile past pending.
- **"Finish on WhatsApp".** It appears only when the S1.6 onboarding agent is on for the applicant's cohort.
- **PAN path (N27b).** Not built. It is written up as **ADR-016 (Proposed)**, `docs/adr/016-gst-exempt-providers.md`, and waits on D3 plus a CA's answers on §52 / §9(5).

---

### E11: Provider workspace v3

**Problem.**
- **The provider home** has a status banner, 3 stats, the (dark) score card and 5 tiles. It doesn't show what's due.
- **The inbox:** 3 tabs (Open / Quoted / Closed) with counts, and **no filters, search or sort**.
- **The quote form:** GST and transport are selects, and there are no required marks.
- **Visibility:** providers can't see their funnel or why they lose.
- **Tenders:** there's no tender feed and no GeM help. The survey found both at IndiaMART and Tata nexarc.

**Pairs:** P53–P59.

**Requirements**

- **FR-11.1: Today.** The provider home, task-first.
  - **"Needs your action"** (N2, provider kinds):
    - new matched RFQs, closing soonest first;
    - orders to accept (the 24 h clock);
    - requirements received, ready to start;
    - deliveries due;
    - revisions requested;
    - clarification questions to answer (S1.3);
    - dispute statements due (S1.7);
    - Munshi drafts ready (dark, S2.2).
  - **Funnel card (N29):** the last 7 or 30 days. Profile views → matched → quoted → won, with conversion rates and the top decline reasons.
  - **Payouts panel:** scheduled (date + sum), on hold (the reason), paid in the last 30 days. It reads the existing payouts and links to `/partner/earnings`.
  - **Availability (N11, from E3):** "Next available start: Mon 6 Oct · Edit". Display only; fan-out doesn't change.
  - **Score card:** unchanged, when `score_card_enabled` (S2.4).
- **FR-11.2 (N28): inbox v2.**
  - **Tabs:** Open · Quoted · Closed (+ Tenders when D9 passes).
  - **Filters:** category, state, budget band, closing soon (< 12 h), buyer verified (D2), has attachments.
  - **Sort:** newest · closing soon · budget high.
  - **Search:** by title.
  - **Desktop:** a Compact table. **Mobile:** cards with the same facts, filters in a sheet.
  - Filters live in URL parameters, so a filtered view can be bookmarked and shared inside the team.
  - Every filter runs on the server over the existing matched-RFQ query, so **no filter can widen what RLS returns**.
- **FR-11.3 (N28b, gated by D2): "Buyer verified ✓".**
  - Shown when the buyer's Udyam or GSTIN is verified **and** they have ≥ 1 paid order on AMClub (with any provider).
  - The inbox payload carries **a boolean only**. No buyer id, name, count or contact before a quote, so the masking rules stay intact.
  - Fan-out and the 7-quote cap don't change, so new buyers aren't excluded.
- **FR-11.4: quote form v3.**
  - Required fields marked.
  - **GST** (included / extra / not applicable) and **transport** as 3-option `SegmentedControl`s.
  - Valid-until uses a `DatePicker` with presets: 3, 7, 14 days.
  - Advance % as chips (0 · 20 · 50 · custom) within the existing cap.
  - "What's included" starts from the service's scaffold text.
  - **Server preview**, below the price:
    - "Buyer sees: ₹4,500 + 18 % GST = ₹5,310 all-in";
    - "You receive ≈ ₹4,050 after AMClub's fee · paid 2 days after the buyer accepts".
    - Both lines come from `POST /api/v1/rfq/[id]/quote/preview`. It's pure computation over the same shared functions as compare (`compareQuotes`) and checkout (`computeOrderAmounts`, and `computeGstInclusiveOrderAmounts` when GST is included, per ADR-015). "You receive" is their `providerEarningPaise` (taxable − commission) at the provider's current commission. No write; clients never compute money.
  - **Munshi inline (P56, dark):** "Draft from my price book" fills the fields; the provider reviews and submits. It's recorded in `ai_decisions` as S2.2 does today.
  - **Speed tiers** appear here when E12b ships.
- **FR-11.5 (N29): `/partner/insights`.**
  - A weekly funnel chart. Static bars; no animation.
  - **Why you lost (from N22):**
    - "You lost 6 of 9 on price, by a median of 12 %".
    - "…on delivery time, by a median of 2 days".
    - Deltas only. **Never another provider's name or price.** A delta shows only when n ≥ 5.
  - **Decline reasons** from the existing enum, shown only when a reason has n ≥ 3, so no single buyer is identifiable.
  - **Listing performance:** views, Buy-now clicks and orders per package.
  - **Never** the composite AMC Score; that stays on the score card alone.
- **FR-11.6 (N30, gated by D9 and its own §8.1 mini-PRD): tenders and the GeM checklist.**
  - **Tender alerts:** for verified providers in the govt-and-licensing categories. Matched by category keywords and the states served.
    - Each alert shows the title, department, value band, closing date and a link to the official portal.
    - "Save" and "Not relevant" feed matching.
    - **No bidding and no applying inside AMClub.** It's alerts only. The data source and its licence are part of the mini-PRD.
  - **GeM seller checklist:** a CMS page built from the survey's checklist.
    - It shows its `reviewed_at` date.
    - Hidden automatically 180 days after the last review, until someone re-reviews it.
- **FR-11.7: listings.** The tier editor (E4) and the add-on editor (E12a) live here, plus each listing's views → clicks → orders.

**UI: Today, desktop (Compact)**
```
┌──────────┬───────────────────────────────────────────────────────────────────────────────┐
│ AMClub   │ Today                                                   Next available Mon 6 Oct│
│          │ NEEDS YOUR ACTION                                                             6 │
│ ● Today  │ ┌───────────────────────────────────────────────────────────────────────────┐   │
│   RFQs 4 │ │ New RFQ · GST returns FY 25-26 · Hyderabad · ₹4–6k     closes in 9 h    › │   │
│   Orders2│ │ Accept order A1B2 · GST registration Standard          within 14 h      › │   │
│   Listings│ │ Delivery due · Trademark filing · Rao Textiles        Thu 2 Oct        › │   │
│   Earnings│ │ Question on "Factory licence" from a buyer             asked 2 h ago    › │   │
│ ──────── │ └───────────────────────────────────────────────────────────────────────────┘   │
│ Insights │ THIS WEEK                                PAYOUTS                                │
│ Reviews  │ Views 212 → Matched 14 → Quoted 9 → Won 3 │ Scheduled  ₹12,480 · Fri 3 Oct         │
│ Profile  │ Lost on price 4 · on time 2                │ On hold    ₹3,200 · dispute open      │
│ Tenders  │                                           │ Paid (30d) ₹48,900        Earnings ›  │
└──────────┴───────────────────────────────────────────────────────────────────────────────┘
```

**UI: RFQ inbox, desktop (Compact)**
```
RFQs    Open 12 · Quoted 9 · Closed 40          [ Search titles ]   Sort: Closing soon ⇅
[Category ▾] [State ▾] [Budget ▾] [Closing < 12 h] [Buyer verified ✓] [Has files]
┌─────────────────────────────────┬──────────────────┬──────────┬───────────┬───────┬──────────┬────┐
│ Requirement                     │ Category · State │ Budget   │ Needed by │ Quotes│ Closes in│ ✓  │
├─────────────────────────────────┼──────────────────┼──────────┼───────────┼───────┼──────────┼────┤
│ GST returns FY 25-26            │ Tax · TG         │ ₹4–6k    │ 10 Oct    │ 3 / 7 │ 9 h      │ ✓  │
│ Factory licence renewal         │ Licensing · AP   │ ₹8–12k   │ 20 Oct    │ 1 / 7 │ 1 d 4 h  │    │
│ CNC bracket, 200 pcs (STEP)     │ Job work · TG    │ ₹40–60k  │ 30 Oct    │ 5 / 7 │ 2 d      │ ✓  │
└─────────────────────────────────┴──────────────────┴──────────┴───────────┴───────┴──────────┴────┘
```

**UI: quote form, mobile**
```
┌────────────────────────────────────────┐
│ ◀  Quote · GST returns FY 25-26        │
│ Price (₹) *          Delivery (days) * │
│ ┌──────────────┐     ┌──────────────┐  │
│ │ 4,500        │     │ 4            │  │
│ └──────────────┘     └──────────────┘  │
│ GST *   [ Extra ][ Included ][ N/A ]   │
│ Transport * [ Extra ][ Included ][ N/A ]
│ Advance  [0 %][20 %][50 %][Custom]     │
│ Valid until * [ 3 d ][ 7 d ][ 14 d ]   │
│ What's included *                      │
│ ┌────────────────────────────────────┐ │
│ │ 12 monthly returns + annual recon… │ │
│ └────────────────────────────────────┘ │
│ Buyer sees  ₹4,500 + 18 % GST = ₹5,310 │
│ You receive ≈ ₹4,050 · 2 days after    │
│ the buyer accepts                      │
│┌──────────────────────────────────────┐│
││            Send quote                ││
│└──────────────────────────────────────┘│
└────────────────────────────────────────┘
```

**Data and API**
- `GET /api/v1/me/actions` gains the provider kinds.
- Inbox query parameters: `category`, `state`, `budget`, `closing`, `verified`, `files`, `q`, `sort`. A Zod schema in shared.
- `POST /api/v1/rfq/[id]/quote/preview`: rate-limited; no write.
- **`view_counts_daily`:**
  - Columns: `subject_kind` (provider / package), `subject_id`, `day`, `views`.
  - Written by `POST /api/v1/views`: a rate-limited beacon that deduplicates per session per day and skips bots and the owner's own views.
  - The service role writes; a provider reads only their own rows.
- `GET /api/v1/partner/insights?range=7d|30d`.
- **Gated by D9:** `tender_alerts`, `tender_feedback`. The GeM checklist is CMS content with `reviewed_at`.
- **Rollback:** additive; flags off.

**Events**

| Event | Properties |
|---|---|
| `partner_home_viewed` | `actions` |
| `partner_action_clicked` | `kind` |
| `inbox_filter_changed` | `key` |
| `inbox_sorted` | `key` |
| `quote_form_started` | `entry` |
| `quote_preview_shown` | `gst_mode` |
| `quote_submitted` | `from_draft`: bool |
| `insights_viewed` | `range` |
| `tender_alert_opened` | |
| `tender_alert_feedback` | `useful`: bool |
| `gem_checklist_viewed` | |

**Flags:** `exp_v3_partner`; `buyer_verified_badge_enabled` (D2); `tenders_enabled` (D9).

**Acceptance**
- A provider fixture with one item of each kind sees every row, in deadline order.
- **`verify-authz` gains:**
  - inbox filters never return an RFQ the provider isn't matched to;
  - before a quote, the inbox payload has only a boolean for "buyer verified", with no buyer id, name or contact;
  - `view_counts_daily` rows are readable only by their provider.
- **One number everywhere:** for the same quote, the quote preview equals the compare normalised total and the checkout amount. A shared test covers `gst_included` = true / false / null.
- **Insights privacy:** no reason shows with n < 3, and no delta with n < 5. No route returns the composite score except the existing score card.
- **Tenders:** no bid or submit control exists (a static assertion).

**RICE:** R 0.9 · I 1 · C 0.8 · E 4 → **0.18**.

**As built (E11a: Today, inbox v2, view counts).** E11 ships as two PRs. E11a is this one. E11b adds the quote form v3 with the server preview, `/partner/insights`, listing performance, and the gated tenders / GeM checklist.
- **Flag.** `EXP_V3_PARTNER`.
- **Today** (`/partner`).
  - **Needs your action** (≤ 5; "See all" → `/partner/actions`):
    - order rows from `nextAction` (accept, start, deliver, revise, dispute statement);
    - new matched RFQs, closing soonest first;
    - `buyer_message`: a quote thread whose latest message is the buyer's;
    - `munshi_draft`: proposed drafts, only while Munshi is on for the provider.
  - The PRD's "clarification questions to answer" is `buyer_message`: in S1.3, clarifications are provider → buyer, and buyers write to providers in quote threads.
  - **Funnel card** (7 / 30 days via `?range=`): views → matched → quoted → won, with rates. Decline reasons show only with n ≥ 3 (shared `buildFunnel`).
  - **Payouts panel:** scheduled with the next date, on hold with the `payout_held` reasons, and paid in the last 30 days. It reads the ledger only.
  - **Next available start** (E3's `next_available_on`) and the score card are unchanged. The banners stay.
- **Inbox v2** (`/partner/rfqs`).
  - Tabs with filtered counts, and filters for category, state, budget band (overlap), closing < 12 h, buyer verified and has files.
  - Title search, and sort by newest, closing soon or budget high.
  - Everything lives in the URL (shared `parseInboxQuery` / `inboxQueryToString`). It runs in memory over the provider's own matched rows (`loadProviderInboxMatches`, the v2 loader), so a parameter can only narrow.
  - Desktop gets a Compact `DataTable`; phones get cards, with the filters folded.
- **Buyer verified** (D2, dark behind `buyer_verified_badge_enabled`).
  - Shown when Udyam or GSTIN is verified and the buyer has at least one order. Every `orders` row exists only after a captured payment.
  - The inbox carries a boolean only. The rig checks the buyer's business name and id never appear.
- **View counts** (N29).
  - Migration 0056 adds `view_counts_daily` (provider reads own; RLS). It is written only by `bump_view_count()` (service role, active subjects only).
  - The beacon `POST /api/v1/views` fires from the provider and package pages while the `partner` experience is live. It skips bots and the owner, and counts a visitor (IP + UA) once per subject per IST day through the `viewOnce` limiter, with an IP cap.
- **Privacy checks.** `verify-authz` checks that view counts are readable only by their provider. The inbox privacy checks run in the experience rig: they need a cookie session and the flag.

**As built (E11b: quote form v3 and the server preview).** Insights, listing performance and the gated tenders / GeM checklist follow in E11c.
- **One number per quote (ADR-017).**
  - Shared `quoteChargeAmounts` is the one rule: included → carve GST out (ADR-015); extra or unstated → GST on top.
  - Checkout's quote branch now calls it. This is a refactor, and checkout behaviour is unchanged.
  - `compareQuotes` now adds GST for an **unstated** quote too, as checkout always charged it. The `gst_unstated` flag stays, and the retired note was "GST unstated — not added".
  - A shared test pins preview = compare = checkout for `gst_included` true / false / null. The rig checks it end to end.
- **Preview.** `POST /api/v1/rfq/[id]/quote/preview` is matched providers only, rate-limited, with no write. It returns "Buyer sees ₹X + 18 % GST = ₹Y all-in" (or "₹Y, GST included") and "You receive ≈ ₹E … paid 2 days after the buyer accepts", at the RFQ category's current commission.
- **Form** (`QuoteComposer` `v3`, services only; revise stays v2).
  - Required marks, and GST as a required Extra / Included control. "Not applicable" waits for ADR-016.
  - Transport as Extra / Included / N/A. Valid-until presets for 3 / 7 / 14 days plus a date. Advance chips 0 / 20 / 50 / custom.
  - "What's included" starts from a scaffold, and the preview updates under the price.
- **Munshi.** The inline draft keeps S2.2's path (`munshi_draft_id`, `ai_decisions`).

**As built (E11c: insights, listing performance, tenders + GeM checklist).**
- **Insights** (`/partner/insights`, `GET /api/v1/partner/insights?range=7d|30d`; flag `partner`).
  - An 8-week IST funnel with static bars (shared `weeklyBuckets`).
  - "Why you lost" (shared `lossInsight`): the winning quote on each RFQ the provider lost is read on the server, and totals use the one quote rule (ADR-017). Only counts and medians leave the server, and a median only with n ≥ 5. The rig checks that no other provider's name or price is in the payload.
  - Decline reasons show only with n ≥ 3 (`buildFunnel`).
  - Listing performance per package: views (`view_counts_daily`), checkouts started (`checkout_sessions`, the Buy-now clicks that reached payment) and orders.
  - It never includes the composite AMC Score.
- **Tenders (D9, dark).**
  - Behind `agent_settings.tenders_enabled`. Migration 0057 adds `tender_alerts` and `tender_feedback` (service role). The feed is filled by the D9 mini-PRD's import; the data source and its licence are decided there.
  - `/partner/tenders` is for active government-and-licensing providers. Alerts match on category overlap and state (an empty state list = national), and only open ones show.
  - Each alert has the official portal link, Save and Not relevant. There is **no** form, bid, apply or submit control, and the rig asserts it.
- **GeM checklist.** `cms_pages` (0057) holds it, seeded unreviewed. RLS and `isReviewFresh` show a page only within 180 days of its last review, so it hides itself when stale.

---

### E12: Order-value extensions (the ADR track)

**Three sub-epics.** Each has its own ADR, flag, RICE and PR, and they're never combined. All three change money, so each adds a money-rig criterion and goes through §8.4.

**ADR numbering.** The ADRs are named **ADR-XA / XB / XC** here, and ADR-XD is in E10. Real numbers are assigned when each is written, because 011–013 may already be reserved by the agent programme.

**Common rules**
- **No second money path.** Every amount comes from `computeOrderAmounts` / `computeGstInclusiveOrderAmounts` on the server, and is frozen into the checkout session.
- **The webhook stays the only truth.** A replayed webhook never creates twice.
- **No new order states** unless the ADR proposes them. Transitions are never repurposed.
- **Not negotiation (§8.3).** The provider sets every option before the buyer sees it, and the buyer only picks. There's no counter-offer anywhere.

#### E12a: Add-ons (N15, ADR-XA)

**Why:** Fiverr's priced extras (FV-07) are the survey's clearest take-rate lever. Buyers want fast-track and an extra revision.

**Requirements**
- **`package_addons`:**

  | Column | Rule |
  |---|---|
  | `id`, `package_id` | |
  | `label_i18n` | ≤ 40 characters |
  | `price_paise` | bigint, > 0 |
  | `days_delta` | int; negative for fast-track; total days never < 1 |
  | `extra_revisions` | int ≥ 0 |
  | `active` | |
  | timestamps, `deleted_at` | |

  **At most 3 active per package**, enforced by a trigger and by Zod.
- **Checkout:** the route accepts `addonIds[]`.
  - The server loads the package's active add-ons, ignores any client prices, and sets **subtotal = package price + Σ add-on prices**.
  - Then it runs `computeOrderAmounts` once. The coupon applies to the whole subtotal (one rule; the ADR confirms it).
- **Snapshot:** `orders.addons` (jsonb, frozen at session creation): `[{id, label, pricePaise, daysDelta, extraRevisions}]`. The due date and revision allowance come from the snapshot.
- **Invoices:** `generateInvoices` writes one line per add-on at the same GST rate.
- **Disputes:** settled on the order total. `planDisputeSettlement` is unchanged, and add-ons aren't separable in v1.
- **Display:** `AddOnList` ("+₹500 · 1 day faster"). The buy box total comes from `POST /api/v1/checkout/preview`, so the client never adds numbers.
- **Scope:** packages only. Quotes use options (E12b).

**Acceptance (money-loop rig criterion)**
- A package + 2 add-ons → webhook → order amount = server preview = invoice sum.
- A tampered client price is ignored.
- An add-on removed between preview and payment → 409 `addon_changed`.
- A replayed webhook creates nothing.

**RICE:** R 0.5 · I 1 · C 0.6 · E 2 → **0.15**.

**As built (E12a: ADR 019, migration 0065; dark behind `addons_enabled`).**
- **Prerequisite (ADR 018, migration 0064).** Checkout sessions and orders became server-written only before this landed, so the frozen snapshot cannot be rewritten from the client.
- **Data.**
  - `package_addons`: ≤ 3 active per package (the trigger `package_addons_limit` locks the package row; shared `packageAddonInputSchema`). Anyone reads the active add-ons of an active package; the provider reads their own. No client writes.
  - `checkout_sessions.addons` / `orders.addons`: the snapshot `[{ id, label, pricePaise, daysDelta, extraRevisions }]`.
  - The trigger `checkout_sessions_copy_addons` copies the snapshot onto the order when `materialize_order` links the session. Neither version of the function is redefined, and a replay copies nothing.
- **One rule.** Shared `packageCharge`:
  - subtotal = package + Σ add-ons;
  - the package % discount applies to the package price only;
  - a coupon applies to the whole pre-GST subtotal (`couponBasePaise`);
  - one `computeOrderAmounts` call, byte-identical to before when there are no add-ons (unit-pinned);
  - delivery = max(1, days + Σ delta); revisions = count + Σ extras.
- **Where the rule runs.** Checkout's package branch, `POST /api/v1/checkout/preview` (public, per-IP limited, 404 while off), the coupon route (`addonIds`) and the v3 checkout page all call it.
- **Checkout.**
  - `addonIds[]` covers the package branch only.
  - An id that isn't an active add-on of this package, or any add-on while the switch is off → **409 `addon_changed`**, with no session.
  - A resumed session with a different selection → 409. The web idempotency key includes the selection.
  - Anything else the client sends about prices is never read.
- **Invoices.** The buyer invoice has the package line plus one line per add-on at the same GST rate. `totals.lines` + `discount_paise` are recorded, and PDF labels are made safe for the standard font.
- **UI.**
  - Provider: an "Add-ons" editor on the listing edit page (own package only): create, pause / resume, remove. It is written through `/api/v1/partner/packages/[id]/addons[/…]` on the service role; delegated tokens are refused.
  - Buyer:
    - The v3 buy box shows `AddOnList` ("+₹500 · 2 days faster"). Ticking one asks the preview for the new total, delivery and revisions, and Buy now carries `?addons=`.
    - Checkout re-reads and re-prices the selection, lists "Includes: …", and drops anything no longer offered with a note.
    - The order overview lists "Add-ons bought" for both parties.
- **Disputes / payouts.** Unchanged (settled on the order total).
- **Mobile.** Mobile Buy now sends no add-ons and is unchanged.
- **Tests.**
  - Shared unit tests (`addons`).
  - `verify-money-loop` E12a:
    - preview = shared rule = checkout amount, with tampered client prices ignored;
    - a replayed capture (simulate and `materialize_order`) creates nothing;
    - order amounts, days and revisions come from the snapshot;
    - the buyer invoice lines − discount + GST = the order total;
    - a paused add-on → 409 with no session;
    - switch off → 409 / 404.
  - `verify-authz` 7a2:
    - off → 404;
    - owner-only writes; another provider or a buyer is locked out;
    - a 4th active add-on → 409;
    - anon reads active only;
    - no direct client insert or update.

#### E12b: Speed tiers in quotes (N21, ADR-XB)

**Why:** Xometry quotes Economy / Standard / Express (XM-04), and Moglix offers 24 h vs 5 days (MG-04). The buyer picks the trade-off; no negotiation.

**Requirements**
- **`quote_options`:** `id`, `quote_id`, `label` (`economy` | `standard` | `express`), `price_paise`, `delivery_days`, timestamps.
  - At most 3 per quote; labels unique per quote.
  - A quote without options behaves exactly as today.
  - **`quoteOptionsSchema` (shared) enforces coherence:** express is faster than standard, which is faster than economy, and prices never fall as speed rises.
- **Quote form:** "Offer faster or cheaper options" (off by default) opens 2 more rows. The server preview (FR-11.4) runs per option.
- **Compare:**
  - Each quote column shows option chips.
  - The normalised total and flags follow the selected option (default: `standard`).
  - "Fastest" and "lowest" are computed across options by `compareQuotes`, which is deterministic and lives in shared.
- **Accept:** `optionId` is passed into checkout.
  - The checkout quote branch reads the option's price and days, and ADR-015 applies per option (the quote's `gst_included` covers all its options).
  - `finalizeQuoteAcceptance` records `quotes.selected_option_id` from the webhook's session data.
  - N22 loss labels compare against the **winning option**.
- **Revisions:** the S1.3 in-place revision can edit options within the existing cap, under the same optimistic lock.
- **The 7-quote cap is unchanged.** Options are not extra quotes.

**Acceptance (`verify-rfq` criterion)**
- Accepting B's express option → order amount = the option price (with GST per ADR-015), and the due date follows the option's days.
- A replay creates nothing.
- An `optionId` from another quote → 404.
- Incoherent options are rejected with 400.

**RICE:** R 0.4 · I 1 · C 0.6 · E 2 → **0.12**.

**As built (E12b: ADR 020, migration 0066; dark behind `quote_options_enabled`).**
- **Model.**
  - The quote row IS Standard, so every existing reader is unchanged.
  - `quote_options` holds Economy / Express per quote **revision**. Rows are immutable, service role only, and unique per (quote, revision, label).
  - `quotes.selected_option_id` and `checkout_sessions.quote_option_id` are nullable (null = Standard).
- **Shared.**
  - `quoteOptionsSchema` (≤ 2 rows, one per label, strict).
  - `quoteOptionsProblems`: Express strictly faster and never cheaper; Economy strictly slower and never dearer.
  - `quoteChoices`: each choice's checkout total (ADR-015 per option) and flags (`compareQuotes` with the other quotes at Standard).
  - `choiceExtremes` (lowest / fastest across every choice); unit tests.
- **Quote routes.** POST and PATCH take `options`, and a revision restates them. The server checks them before any write:
  - goods → 422;
  - switch off → 422 `options_unavailable`;
  - incoherent → **400 `options_incoherent`**.

  The rows are written under the quote's revision, and the `submitted` / `revised` events carry them.
- **Provider form.** "Offer faster or cheaper options" is off by default. It appears in both forms, so a revision never drops options, and each row shows the server's "Buyer sees ₹X all-in".
- **Compare.**
  - Option chips per quote column (Economy · Standard · Express). The price, total, delivery, flags and confirm sheet follow the picked chip.
  - A "Lowest: … · Fastest: …" line across every option.
  - Accept sends `optionId`, and each choice has its own idempotency key.
- **Checkout.**
  - The option must be this quote's, at its current revision, with the switch on; otherwise **404 `option_not_found`**, including another quote's option.
  - Price = the option's price under the quote's GST mode; days = the option's days (the due date).
  - A live session on another option → 409 `rfq_checkout_in_progress`.
- **Finalize.** Records `selected_option_id` from the frozen session. N22 loss labels use the winning option's price and days.
- **Events.** `quote_option_added { label }` (provider form), `quote_option_selected { label }` (compare).
- **Tests.**
  - Shared `quote-options` tests.
  - `verify-rfq` 11:
    - incoherent → 400; two options stored;
    - an option from another quote → 404;
    - Express accepted → order = option price + GST, days = 4, quote records the option;
    - a signed webhook replay creates nothing;
    - the loss label is against Express.
  - `verify-authz` 7a3: clients can't read or insert `quote_options`.

#### E12c: Compliance bundles with milestone escrow (N18, ADR-XC)

**Why:** Vakilsearch Elite (VS-01) and IndiaFilings sell registration + 12 months of filings. It's the strongest 90-day-repeat lever in the survey.

**Proposal for the ADR**
- **A bundle is a package of kind `bundle`** with `bundle_milestones`: `seq`, `label_i18n`, `due_offset_days`, `share_bps`. The shares sum to 10,000.
- **One payment, N child orders.**
  - When the webhook captures the payment, it creates **one ordinary order per milestone**, each with its share (the last milestone takes the paise remainder).
  - Each child runs the ordinary state machine, so **the payout rule is untouched**: each child pays out at T+2 after its own completion.
  - `orders.bundle_purchase_id` links the children to a `bundle_purchases` row.
- **Cancellation:** unstarted children are refunded in full through `processRefund` (a partial refund of the one payment). ADR-014's one-refund-row-per-order rule holds per child.
- **If the provider is suspended:** unstarted children are refunded. Moving them to another provider is a new purchase that the buyer consents to; money is never moved automatically.
- **Duration:** **≤ 3 months prepaid in v1.** Holding buyer money for 12 months raises payment-aggregator settlement questions (RBI PA guidelines, Razorpay Route hold limits) that counsel and Razorpay must answer first. Renewal ("Renew next quarter") is a new purchase.
- **`/app/plans`:** a milestone timeline, the next milestone due, money held, and "Cancel remaining".

**Acceptance (money-loop rig criteria)**
- A 3-milestone bundle → 3 child orders from one webhook. Their amounts sum exactly to the captured payment. A replay creates none.
- Cancelling after milestone 1 refunds exactly milestones 2 and 3, with one refund row per child.

**RICE:** R 0.2 · I 2 · C 0.5 · E 2.5 → **0.08**.

**As built (E12c: ADR 021, migration 0067; dark behind `bundles_enabled`; enabling waits on counsel + Razorpay).**
- **Model.**
  - A package with 2–6 `bundle_milestones` is a bundle: `seq`, label, due offset ≤ 92 days, `share_bps` summing to 10,000, offsets strictly increasing. Shared `bundleMilestonesSchema` enforces it; the partner route is the only writer.
  - `bundle_purchases`: one per paid plan, carrying the ONE payment. Parties read their own; no client writes.
  - `orders.bundle_purchase_id` / `bundle_seq` / `available_at`.
  - `checkout_sessions.bundle_plan`.
- **The split.**
  - Shared `bundlePlan`, computed once at checkout: floor split of price, discount, GST and commission per share, the last milestone taking the remainder; taxable, total and earning derived per child.
  - Every column sums exactly to the whole, and Σ children = the captured payment (unit-pinned).
  - Add-ons are not offered on plans (409); a coupon applies to the whole.
- **Materialisation.**
  - The trigger `checkout_sessions_materialize_bundle` runs in the same transaction that links the session: it records the purchase, turns the materialised order into child 1, and inserts children 2..N from the frozen plan.
  - A replayed webhook creates nothing.
  - Later children become actionable at `available_at`. Auto-cancel's 24 hours count from then (`staleOrdersForAutoCancel`, with a fallback before 0067, plus a guard in `autoCancelOrder`).
- **Refunds per child on one payment.**
  - `paymentForOrder` / `refundForOrder` run byte-identical queries for ordinary orders.
  - A child resolves its purchase's payment and its OWN refund row (`rfnd_<order id>`).
  - Used by `processRefund`, dispute resolve, and the admin order / dispute views.
- **Cancel remaining.** `POST /api/v1/bundles/[id]/cancel-remaining` (the buyer's own session) sends every unstarted child (`placed` / `accepted`) through the ordinary `cancel` transition: 100 % back, one refund row each. Started or finished children are untouched.
- **UI.**
  - Provider: a "Sell as a plan" milestones editor.
  - Buy box: "Pay once · N milestones over D days" with the exact split.
  - Checkout: the plan lines.
  - `/app/plans`: timeline, next due, money still held, "Cancel remaining" behind a confirm sheet.
  - Each child's order page: "Milestone k of your plan · starts …".
- **Events.**
  - Client: `bundle_viewed { milestones }`, `plan_cancel_requested { remaining }`.
  - Server: `bundle_purchased`, `bundle_milestone_completed { seq }`, `plan_cancelled`, `bundle_milestones_saved { n }`.
- **Tests.**
  - Shared `bundles` tests: exact sums across prices, consistency, offsets, schema.
  - `verify-money-loop` E12c:
    - one capture → 3 children equal to the frozen split, Σ = the payment;
    - a replayed `materialize_order` creates nothing;
    - a future child older than 24 h is not auto-cancelled;
    - milestone 1 under way, then cancel remaining → 2 and 3 refunded in full, one row each, 1 untouched;
    - a second cancel refunds nothing more.
  - `verify-authz` 7a4: routes 404 while off; no direct client writes.

**E12 events**

| Event | Properties |
|---|---|
| `addon_toggled` | `on`: bool |
| `checkout_addons` | `count` |
| `quote_option_added` | `label` |
| `quote_option_selected` | `label` |
| `bundle_viewed` | |
| `bundle_purchased` | server |
| `bundle_milestone_completed` | server; `seq` |
| `plan_cancel_requested` | `remaining` |

**Flags:** `addons_enabled`, `quote_options_enabled`, `bundles_enabled`.

---

### E13: Mobile parity

**Problem.**
- The app has **28 screens** and buyer flows are close to complete.
- **Providers**, who run their business from phones, have only home, RFQs, one RFQ and Munshi.
- **Missing for providers:** listings, the provider orders list (the mobile orders list is buyer-only today: `fetchMyOrders('msme')`), earnings, reviews, profile.
- **Missing for buyers:** profile and invoices.
- Onboarding opens the web in a browser.

**Pairs:** P60.

**Requirements**
- **FR-13.1: role-aware tab bars, identical to E1:**
  - **Buyer:** Home · Search · Requirements · Orders · Saved (+ Mart when live).
  - **Provider:** Today · RFQs · Orders · Listings · Earnings.
  - The current "Partner" tab goes away. A user with both roles switches from the avatar sheet.
- **FR-13.2: provider screens:**
  - orders list;
  - the order workspace (E8) with provider actions: accept, start, deliver with upload;
  - listings: list, pause/resume, edit the basics. The tier and add-on editors stay web-first in v3, behind an "Edit on web" link;
  - earnings: scheduled, on hold, paid;
  - reviews;
  - profile, including availability (N11);
  - insights (N29), read-only.
- **FR-13.3: buyer screens:** profile, and invoices (list + PDF via a signed URL).
- **FR-13.4: native provider onboarding (D-PRD3).** The E10 4-step wizard as native screens. It shares the Zod schemas, uses the camera for documents, and resumes the same draft as the web.
- **FR-13.5: native feel.**
  - The `ui-v3` RN twins (E1).
  - Sheets with detents.
  - A light haptic on every primary confirm (pay, accept, send quote).
  - The Gold Stamp and the Paisa Moment on the native animation thread, with the same duration budgets.
  - Reduced motion respected.
- **FR-13.6: notifications** open the exact screen and action (the §4.2 deep-link contract).
- Everything goes through `/api/v1`. There's no direct table access from the new screens.

**Data and API.** None new. The screens use the E8–E11 endpoints.

**Events:** the web events, with `platform: 'android'`.

**Flag:** `exp_v3_mobile` (read from `/profile/me`, like `martEnabled`).

**Acceptance**
- Every provider task in E11 is possible on mobile, except tier and add-on editing. A checklist is run per release.
- Component tests for each new screen.
- The Gold Stamp and the Paisa Moment stay within their duration budgets on a mid-range Android.
- **Out of scope:** Android E2E automation in CI (a follow-up).

**RICE:** R 0.5 · I 1 · C 0.8 · E 4 → **0.10**.

**As built (E13a: tab bars, provider listings / earnings, buyer profile / invoices).**
- **Flag.** `EXP_V3_MOBILE`, delivered as `/profile/me.mobileV3Enabled`; off = the v2 tab bar exactly as before.
- **FR-13.1.** Shared `mobile-v3.ts`: `mobileTabsFor` (buyer Home · Search · Requirements · Orders · Saved (+ Mart when live); provider Today · RFQs · Orders · Listings · Earnings; no Partner tab), `mobileRolesOf` / `initialMobileRole` (the device remembers the side; an account loses a side it no longer has). The layout orders the tabs by role; the profile (avatar) sheet switches sides. The Orders tab lists the provider's orders on the provider side.
- **FR-13.2 (part).** Listings: every listing with status, stored price and discount, pause / resume through the web's status route (now Bearer-aware; the provider's own RLS still decides), "Edit on web" for everything else. Earnings: the payout ledger grouped scheduled (incl. on its way / delayed) · on hold (existing hold reasons) · paid (shared `groupPayoutsForEarnings`).
- **FR-13.3.** Profile sheet (name, the side switch, invoices, notifications, help, language, sign out) and Invoices (the web rows; 15-minute signed PDF links fetched on each visit).
- **API.** Thin GETs over the web's own loaders, 404 while the flag is off: `/api/v1/partner/packages`, `/api/v1/partner/payouts`, `/api/v1/me/invoices`.
- **Tests.** The screens' logic is shared and unit-tested; `verify-experience` e13 drives the routes with Bearer tokens as the app does. RN component tests need a mobile test runner (E13b).

**As built (E13b: the rest of the provider phone kit, deep links, haptics, component tests).**
- **Screens.** Reviews (one public reply each, the web's reply route), Insights (read-only; the web's payload with its n-gates), Profile & availability (N11: next available + capacity through the web's route, now with a GET for the current values), reached from Today and the profile sheet. The order screen's provider side attaches a deliverable (expo-document-picker → the web's documents route, kind `deliverable`).
- **FR-13.6.** Shared `mobileRouteFor(link, { v3 })` is the deep-link contract: every notification link the server sends today maps to its screen, tab and query kept; admin and unknown links stay on the list; unit-tested per link shape.
- **FR-13.5 (part).** `confirmHaptic()` (expo-haptics, light) on pay, accept (quote and order actions) and send quote, only while `mobile` is on.
- **Component tests.** `apps/mobile` now runs jest-expo + React Native Testing Library (`pnpm --filter @amclub/mobile test`, a CI step): Listings, Earnings, Invoices, Profile sheet, Reviews, Insights, Profile & availability. The Jest babel env drops the NativeWind JSX transform.
- **E13c.** Native provider onboarding (D-PRD3), sheets with detents, and the native Gold Stamp / Paisa Moment.

**As built (E13c: native provider onboarding, detent sheets, signature motion).**
- **FR-13.4 (D-PRD3).** `/partner-onboarding` is the E10 wizard as native screens: "What you'll need", then contact → business (GSTIN autofill from the same stub/registry route; the legal name locks once filled; the state picker is a detent Sheet) → credentials & bank (camera via expo-image-picker or a file for each category that needs a credential; bank verified before submit) → review → done. It uses the shared E10 Zod rules (`isValidGstin`, `categoriesRequiringCredential`, `ONBOARDING_V3_STEPS`, `autofilledFields`) and the web's own routes: `onboarding-progress`, `kyc/verify-gstin`, `kyc/verify-bank`, `credential-upload`, `legal/accept` (surface `mobile`), `POST /profile/provider`. These five profile routes now accept the app's Bearer session through `getRequestUser()` (the `getSessionUser` shape; cookie behaviour unchanged) and refuse a delegated agent token (`requireNotDelegated`). Partner → Apply opens it while `mobile` is on; the E10 stall nudge (`/partner/onboarding?step=…`) deep-links to the same step (`mobileRouteFor`).
- **The draft.** Like the web, the field draft stays on the device (SecureStore, 7-day TTL; the bank account number and the registry payload are never stored). What web and phone share is the server progress row the stall nudge reads, so a nudge resumes the step on either.
- **FR-13.5.** `Sheet` (`components/ui/Sheet.tsx`): medium ≈ 50 % / large ≈ 90 % detents, drag the handle to expand, shrink or dismiss; native driver. `GoldStamp` (on the buyer's accept-delivery) and `PaisaMoment` (after the checkout payment lands; the amount is the server's paise formatted, never computed) run on the native driver inside shared budgets: `MOTION_BUDGET_MS` in `packages/shared/src/motion.ts` (700 ms / 900 ms), whose phase tables are unit-tested to sum within them. Reduced motion jumps to the final frame.
- **Tests.** Component tests for the wizard (needs → contact → business with autofill), GoldStamp, PaisaMoment and Sheet; rig `e13c` drives progress → GSTIN → bank → submit with a Bearer token and checks the 401s.
- **Events.** The E10 onboarding events, with `platform: 'android'`.

---

### E14: Language

**Problem.**
- **Web:** en and hi are complete, but **te is 41 % and ta is 18 %**, falling back to English key by key.
- **Database text is en/hi only.** `pickI18n` (`apps/web/lib/format.ts`, and its mobile twin) knows `en` and `hi` and nothing else. Package titles and category names are exactly where buying happens, so Telugu and Tamil users see English there.
- **The field:** IndiaMART has voice search in 9 languages and "View in Hindi".

**Pairs:** P61, P62.

**Requirements**
- **FR-14.1 (N32): te and ta complete on the buying path.**
  - **Namespaces:** search, category and service pages, package, checkout, requirement, compare, order workspace, and the notification templates.
  - **Process:** human translation plus a native-speaker reviewer. Machine drafts may be the input, but a human approves.
  - **The CI gate:** a new `i18n:coverage` script fails when any buying-path key is missing in te or ta. The namespaces are listed in one config file.
- **FR-14.2: database text in 4 languages.**
  - The i18n maps widen to `{en, hi?, te?, ta?}` under one shared `i18nTextSchema`.
  - `pickI18n` on web and mobile falls back te/ta → en.
  - Category and level-2 service names (the E2 content task) ship in all 4 languages.
- **FR-14.3 (N32b, dark): provider content translation.**
  - **What:** the package title, description and "Choose this if…" line, and the profile's About.
  - **Drafting:** a bounded single-shot call, `provider_content_translate@v1` in the prompt registry. One `ai_invocations` row per call.
  - **The S2.1 injection law applies:** the input goes through `envelope()`, and the output through `customerFacingText()`, which rejects contact details and URLs.
  - **Approval:** the provider approves each language side by side in Listings. That writes the text into the i18n map with `source = 'machine_approved'`, plus one `ai_decisions` row (feature `content_translation`).
    - **An unapproved draft never renders.**
    - Buyers see "Translated · View original".
  - **Numbers are copied, never translated.** Money always comes from the server.
  - **Gate:** `AGENT_ENABLED` + `agents_enabled.content_translate` + a cohort.
- **FR-14.4 (D-PRD7): numerals.**
  - Latin digits for money, dates and counts in every locale. That matches GST invoices, bank documents and the Razorpay screens.
  - Indian grouping (₹1,23,456) in every locale.
  - Words in the locale's script.
- **FR-14.5: voice search languages (N5).** Each language turns on only after its eval passes: a 50-query set per language, with a word-error-rate threshold set in the eval. It's fed by F6.
- **FR-14.6: layout.**
  - Tamil strings run long, so there are no fixed-width buttons, and truncation is allowed only on names, with the full text on focus or hover.
  - The `/dev/ui` gallery (E1) renders every component in all 4 languages.

**Events**

| Event | Properties |
|---|---|
| `locale_changed` | `from`, `to` |
| `translation_viewed_original` | |
| `content_translation_approved` | `lang` |

**Flags:** `exp_v3_locales` (turns on te/ta per namespace); `agents_enabled.content_translate` (N32b).

**Acceptance**
- `i18n:coverage` is at 100 % for the buying-path namespaces in te and ta.
- Native speakers review screenshots of 12 key screens in all 4 languages.
- A test shows an unapproved translation never renders.
- Each approval writes exactly one `ai_decisions` row.

**RICE:** R 0.4 · I 1 · C 0.8 · E 2 → **0.16**.

**As built (E14a: the language gate, te / ta drafts, four-language maps, numerals).**
- **FR-14.1.** `apps/web/i18n/coverage.config.json` is the ONE list of 32 buying-path namespaces. `pnpm --filter @amclub/web i18n:coverage` (CI step "Language coverage") fails on a missing te / ta key, a message that does not parse, argument names or tags that differ from English, stale keys, or a draft outside the buying path; `--strict` counts drafts as missing (the launch gate). Today: te 52 % live / 100 % with drafts; ta 44 % / 100 %.
- **Drafts, never silently live.** The missing ~610 te and ~710 ta buying-path strings are machine drafts in `messages/drafts/<locale>.json`, loaded by `i18n/request.ts` between English and the live file only while `EXP_V3_LOCALES=on`, and only for the namespaces in `EXP_V3_LOCALES_NAMESPACES` (unset = all). A reviewer promotes a namespace with `i18n:promote` (moves it live in English key order and logs locale / namespace / keys / reviewer / date in `drafts/REVIEW_LOG.json`). Runbook, the 12-screen review list and the terminology choices to settle: `docs/i18n/REVIEW.md`.
- **FR-14.2.** Shared `i18n-text.ts`: `i18nTextSchema` `{ en, hi?, te?, ta? }`, `pickI18n` (own non-blank slot, else English — never Hindi for te / ta); web and mobile `pickI18n` and shared `pickLocale` are that one function; the catalog `I18nText` type is the shared one. Category names and descriptions in all four languages: shared `CATEGORIES`, the seed, and migration 0060 (names reuse the live gateway copy). Level-2 service names were already four-language (`services` namespace, E2).
- **FR-14.4 (D-PRD7).** `numeralsTag(locale)` (`<locale>-IN-u-nu-latn`) and `formatCount`: Latin digits and Indian grouping for money, dates and counts in every locale, unit-tested for en / hi / te / ta. No native digits in the drafts.
- **FR-14.6.** `/admin/dev/ui` links the same gallery in all four languages and shows a long-label strip (buttons size to their label; only names truncate, full text on hover / focus); its own strings are now in te / ta.
- **Events.** `locale_changed { from, to }` from the header switcher and the gateway (web) and the mobile language setting (`platform: 'android'`).
- **Rig** `e14`: te drafts stay dark with the flag off (English fallback), category names carry te / ta and render on `/te` and `/ta` pages.
- **E14b / E14c.** Below.

**As built (E14b: notification copy in the gate, voice search one language at a time).**
- **Notifications (FR-14.1).** The buyer / provider notification copy (order lifecycle, milestones, auto-cancel / auto-accept, disputes, quotes, RFQ expiry, clarifications, quote and order messages, payouts, duplicate payments) is the `notify` namespace of the message files; `lib/i18n/notify.ts` `notifyText(key, values)` builds the stored `{ en, hi, te?, ta? }` map with next-intl's translator. en / hi text is unchanged; `te` / `ta` are carried only when live, or drafted while `EXP_V3_LOCALES` covers `notify` — otherwise absent, so the reader gets English. `notify` is in the buying-path gate (68 te / ta drafts). Ops-only notices (payout dossier, dispute triage, the ops statement ping) stay en / hi.
- **FR-14.5 (N5).** Shared `voice-languages.ts`: nine candidate languages; `voiceLanguageAllowed` = listed in `agent_settings.voice_search_languages` AND a recorded eval that passes (`voiceEvalPasses`: current `VOICE_EVAL_VERSION`, ≥ 50 queries, WER ≤ 20 %, right category ≥ 85 %; `wordErrorRate` is word-level edit distance over the reference). The catalog mic (`voice-parse` mode=query) answers a transcribed query only in an allowed language; otherwise `unsupported_language` with no parse call, and the mic says "type instead". `pnpm --filter @amclub/web voice:eval -- --lang te --set <jsonl> --token … [--record]` runs a native-speaker set through the app's own STT + parse and records pass or fail in `agent_settings.voice_language_evals` (a stub STT never records). Runbook: `docs/i18n/REVIEW.md` § Voice languages.
- **Rig** `e14b`: notification en / hi from `notify.*`, te / ta absent with the flag off; voice: no eval / 49 queries / unlisted → "type instead", listed + passing → answered.

**As built (E14c: provider content translation, N32b, dark).**
- **Locks.** `AGENT_ENABLED` + `agents_enabled.content_translate` + the cohort; route group `(agent-translate-provider)` (`/partner/translations`), routes `/api/v1/partner/translations` (GET list, POST draft, POST `[id]/approve`, POST `[id]/reject`), each gate → session → `requireNotDelegated` → provider → agent-on.
- **Draft.** `provider_content_translate@v1` (task class `content_translate`, residency in), one bounded call per field (package title, "Choose this if…", the About); the English is enveloped; `customerFacingText` (no contact / payment / links) + shared `contentNumbersProblems` (numbers copied, Latin digits) + length + target script decide; drafts in `content_translations` (migration 0061) never render.
- **Approve.** Side by side, editable; claims the draft, re-checks (English unchanged, numbers, length, contract), writes the slot + `i18n_sources` `machine_approved`, exactly one `ai_decisions` row (feature `content_translation`). Buyers see "Translated · View original" on the package title, the "Choose this if…" line and the About (`TranslatedText`); cards show the text only (a card is a link).
- **Tests.** Golden `provider_content_translate` (13 cases, 8 planted bad outputs refused), the injection set (+17 pairs), `e14c` (dark 404s, an approved slot labelled, drafts never render), `trust:verify:content-translation` on a flag-on server (one decision row per approve, double approve 409, a changed number 422, stale on an English change). Runbook `docs/agents/CONTENT_TRANSLATION.md`.

---

### E15: Data foundations (N35: F1–F10)

**The pattern for every item:**
1. Capture the data now.
2. Run a shadow version that's logged and shown to nobody.
3. Ship only when its measured error is acceptable.

Nothing in this epic is user-visible.

**Where each foundation is built**

| F | Foundation | Built in | What gets added |
|---|---|---|---|
| F1 | Quote outcome labels | E7 (labels) + here | The `compare_flag_viewed` event; an export of (RFQ, quotes, chosen) triples for the eval harness |
| F2 | Typed buyer constraints | E6 | `rfqs.must_haves` |
| F3 | Typed spec ontologies | here | See FR-15.1 |
| F4 | Provider facts + evidence | E3 (evidence, nightly GSTIN re-check, `last_seen_at` via N11) + here | "Declared vs actual" category (FR-15.2) |
| F5 | Search telemetry | E2 (thumbs) + here | See FR-15.3 |
| F6 | Consented corpora | here | See FR-15.4 |
| F7 | Obligations data | E9 (N45) | `buyer_licences`, `obligation_rules`, the 50-profile eval |
| F8 | Goods order attributes | E16 | Mart; staged |
| F9 | Per-user AI cost | — | Nothing. `ai_invocations` already has it |
| F10 | Shadow-prediction table | here | See FR-15.5 |

**Requirements**
- **FR-15.1 (F3): typed specs.**
  - `rfqs.cad_features` (jsonb): bounding box, hole count, entity counts. It's written from the existing deterministic STEP/DXF parse (shared `drawings/`), never a model.
  - `mfgSpecSchema` in shared: process, material, tolerance, finish, inspection. It's an optional block in the job-work requirement template.
  - `packages.deliverables` (jsonb, `[{label_i18n, format}]`). E4's "What you'll get" renders it; prose stays as a fallback.
- **FR-15.2 (F4): "declared vs actual".**
  - A nightly job compares each provider's declared primary category with the categories of their paid orders.
  - A mismatch above 50 % over n ≥ 5 orders becomes a flag in the admin verification queue.
  - Admin-only; it never reaches the provider's public profile.
- **FR-15.3 (F5): search telemetry.**
  - `search_queries`: the normalised parameters and the result count per query. A 20 % sample, no user id, and a 180-day retention.
  - **Attribution:** a `search_id` is carried through package view → checkout → `orders.attribution` (jsonb), so a search can be tied to the order it produced.
  - **A golden set:** 200 queries with their expected top results, run as `eval --set search`.
- **FR-15.4 (F6): consented corpora.**
  - **Consent:** an explicit opt-in, "Help improve AMClub's Hindi and Telugu understanding". Default off, revocable, and revoking deletes the rows.
  - **Voice:** text triples only (transcript → parsed requirement → the buyer's final edit). **No audio is kept**, as the Phase 8b consent note promises.
  - **Images:** image → final-requirement pairs with per-field corrections, from document intake (S1.8). Stored in the existing private bucket under the same retention.
  - **`service_synonyms`:** `term`, `lang`, `category_slug`, `service_slug`, `source`, `reviewed`. It's curated; search reads reviewed rows only.
- **FR-15.5 (F10): `shadow_predictions`.**
  - **Columns:** `id`, `feature`, `model_version`, `subject_kind`, `subject_id`, `predicted` (jsonb), `actual` (jsonb, null until resolved), `error` (numeric), `created_at`, `resolved_at`.
  - Service role only; no client grant. Subject ids only, no personal data. Kept 24 months.
  - Shared `recordShadow()` and `resolveShadow()` are the only writers.
  - **First users:**
    - **The CAD price band:** predicted at fan-out; the actual is the winning option's price.
    - **Provider fit % (rules only):** predicted at fan-out; the actual is quoted / won.
  - A weekly error report in the admin console. It's shown to nobody else.

**Data and API.** Every new table has RLS. All are service-role-only, except `buyer_licences` (owner) and `service_synonyms` (anyone reads reviewed rows).

**Events:** `compare_flag_viewed` (`flag`), `corpus_consent_changed` (`on`), plus the server-side shadow counters.

**Flags:** none user-facing. `shadow_<feature>_enabled` switches on each shadow writer.

**Acceptance**
- Each foundation has a writer test.
- `verify-authz` asserts no client can read `shadow_predictions`, `search_queries` or `view_counts_daily` rows that aren't theirs.
- The shadow price band runs on the seeded CAD RFQs: it writes a prediction and resolves it after acceptance.
- Revoking corpus consent deletes that user's rows (a test).

**RICE:** R 1.0 · I 0.5 · C 0.8 · E 3 → **0.13**. It's scored as an enabler: the value arrives in V1.5–V2.

**As built (E15a: typed specs, shadow predictions, the compare flag + triples).**
- **F3 (FR-15.1).** Migration 0062 `rfqs.cad_features`, written at RFQ create from a confirmed drawing's deterministic parse (shared `cadFeaturesFromDrawing`: format, units, bbox, hole estimate, entity counts — never the product name or prose, never a model). Shared `mfgSpecSchema` (process, material, tolerance, finish, inspection): an optional `details.mfg_spec` block the create route validates (422 otherwise). Shared `packageDeliverableSchema` (`{ label_i18n, format }` or the older prose string) + `deliverableLabel`: web and mobile "What you'll get" render either.
- **F10 (FR-15.5).** `shadow_predictions` (0062; service role only — no grant, no policy; subject ids only; 24 months). `lib/shadow` `recordShadow` / `resolveShadow` are the only writers. First users, each behind its own switch (`shadow_cad_price_band_enabled`, `shadow_provider_fit_enabled`, default off): the CAD price band (rules v1: size class × holes) predicted at fan-out and resolved against the winning quote's all-in total (0 inside the band, else the distance to the nearest edge / actual); provider fit % (rules v1: must-have languages and credentials, track record, rating, availability) per matched provider, resolved at acceptance (quoted / won). Weekly error report at `/admin/shadow` (admin / ops only).
- **F1.** `compare_flag_viewed { flag }` (one per flag kind per compare view, v3). `scripts/export-compare-triples.ts`: one JSON line per accepted services request — salted RFQ ref, the quotes as compare showed them (shared `compareQuotes` totals, GST mode, flags), the chosen index; no provider or buyer identity.
- **Tests.** Shared unit tests (band, fit, weekly report, specs, deliverables); rig `e15a` (a bad mfg_spec 422; cad_features from the drawing; one band + one fit per matched provider at fan-out; the client reads nothing; acceptance resolves the band against ₹5,900 and the fits quoted / won; the admin report renders for admins only); `verify-authz` (no client reads or writes `shadow_predictions`).

**As built (E15b: search telemetry + attribution, declared vs actual, consented corpora, synonyms).**
- **F5 (FR-15.3).** Migration 0063 `search_queries` (service role only; no user id): every v3 results page mints a `search_id`; a sample (`search_telemetry_sample_pct`, default 20, 0 = off; shared `sampledSearch` is deterministic on the id) is written after the response (`lib/search/telemetry`), with shared `normaliseSearch` parameters and the result count. The id rides the result links (`?sid=&pos=`, the rank across pages) into the package page (ISR — `SearchAttributionCapture` keeps it in sessionStorage for 24 h, keyed to that package group) → the checkout body (`attribution`, strict `searchAttributionSchema`; malformed → 422) → `checkout_sessions.attribution` → `orders.attribution`, copied once inside the placed side effects. Attribution is best-effort and never part of the money decision. Golden set `apps/web/evals/search/golden.jsonl` (200 cases: 40 services × 5 phrasings) run by `pnpm --filter @amclub/web eval:search` (hit@3 through the same anon RPC, threshold 85 %); rebuild it from the sampled real queries after launch.
- **F4 (FR-15.2).** Nightly `cron/data-foundations` (21:40 UTC): a provider whose paid orders in the last 180 days (n ≥ 5, services only) sit more than half outside their declared categories (all declared, not only the primary — fewer false flags) gets ONE `category_mismatch_flagged` audit row (re-flag after 30 days), shown to ops on `/admin/verifications` ("Category mismatches"). Never the public profile; nothing changes for the provider. The same job purges `search_queries` after 180 days and `shadow_predictions` after 24 months.
- **F6 (FR-15.4).** `users.corpus_consent_at`; `corpus_voice_triples` (transcript → parse → the buyer's final request — text only, no audio exists to keep) and `corpus_image_pairs` (the private `rfq-attachments` key, the proposal, the final request, shared `intakeCorrections`), service role only, cascade on the user. Written at RFQ create for an opted-in buyer (`lib/corpus`). The opt-in ("Help improve AMClub's Hindi and Telugu understanding", default off) is on the buyer profile behind `corpus_consent_enabled` (default off: hidden, opting in 404s, nothing new is kept; a buyer who already opted in still sees it); `POST /api/v1/me/corpus-consent` (own session only) — revoking deletes that user's rows and returns the count. `service_synonyms` (`term`, `term_key`, `lang`, `category_slug`, `service_slug`, `source`, `reviewed`; anyone reads reviewed rows only): v3 search maps a whole query with a reviewed synonym to its category / service when no category is chosen.
- **Tests.** Shared unit tests (`data-capture`); rig `e15b` (a sid on the result links and its 100 %-sample row with no user id; the order carries the attribution; malformed → 422; six paid orders outside the declared category → one flag, a re-run adds none, admin page only; the switch off hides the opt-in and 404s; consent keeps the image pair by key with its corrections, the buyer reads nothing, revoking deletes; anon reads reviewed synonyms only); `verify-authz` (no client reads `search_queries` or the corpora; no client writes synonyms).

---

### E16: AMC Mart storefront v2 (gated: Mart Launch Gate)

**Rules this epic inherits (CLAUDE.md, MART_DESIGN):**
- Everything lives in the `(mart-*)` route groups, behind `martPageGate()` and `martApiGate()`.
- New columns go in a **new staged migration**, listed as `staged` in `verify-migrations.ts` and deployed only at the Launch Gate.
- **Never name a staged column in a non-Mart query**; `mart:static` enforces it.
- Goods money comes only from `computeGoodsOrderAmounts`.

**Pairs:** P65.

**Requirements**
- **N39: dual mode.**
  - The search field gets a Services | Goods segmented switch, only when `MART_ENABLED`.
  - Goods results offer **"Buy now"** (catalogue SKUs) and **"Make to order"** (a goods RFQ, ADR-007) on the same query. That's 1688's pattern (16-01/05).
  - A zero or weak goods result offers a prefilled goods RFQ (the goods twin of N7).
- **N40: typed attributes and facets.** `mart_category_attributes` (`key`, `type`, `unit`, `facetable`), and product `attributes` validated per category. Goods facets come from these.
- **N41: seller promises.**
  - "Ships in 48 h", "Return shipping covered", "GST invoice within 24 h". The seller opts in per product.
  - **Breaches are measured** from the `dispatch_photo` / `delivery_photo` timestamps. Repeated breaches remove the promise badge automatically.
  - Promises never change the release gate (`evaluateGoodsReleaseGate` is unchanged).
- **N42: samples and customisation.**
  - "Request a sample" is an ordinary goods order of quantity 1 at the seller's sample price.
  - "Customise" opens a goods RFQ prefilled from the product.
- **N43: non-returnable and ITC-ineligible.**
  - `mart_categories.returnable` (config, per category). "Not returnable" shows on the product, cart and checkout.
  - "ITC may not be available on this item" shows where a CA-reviewed category flag says so (§17(5) items). Checkout shows the ITC amount only for eligible lines, computed on the server.
- **N44: the reorder library.** `/app/mart/reorder` lists past goods lines, with "Reorder" at today's server price beside the old one (as N26 does). An opt-in reminder comes at the buyer's usual interval (F8).
- **D4:** custom work stays provider-priced, with guidance bands (the S3.2 benchmark approach). Never platform-priced.

**Acceptance**
- **Inertness with the flag off:** `verify-mart-inert`, `killtest-mart-schema` and `mart:static` pass, and the four services suites stay green.
- `mart:acceptance` gains an N39–N44 check each.

**RICE:** R 0.3 · I 1 · C 0.6 · E 3 → **0.06** (scored for the Launch Gate, not now).

**As built (E16a: dual mode + typed attributes; staged migration 0069, behind `MART_ENABLED` and the Launch Gate).**
- **Migration 0069 is STAGED** with 0022–0025 (`verify-migrations` `staged: true`; `verify-launch-gate` probes `products.attributes`; LAUNCH_RUNBOOK step 3.2 applies it). It changes Mart tables only (`products`, `mart_categories`, three new tables), so `mart:static` has nothing new to guard. `killtest-mart-storefront` proves its constraints and grants on a local DB.
- **N40 typed attributes.**
  - Definitions are `mart_category_attributes` (config, public read, no client writes): `text | number | enum | bool`, unit, options (enums only), `facetable` (enum / bool only), `required`. Seeded for fasteners and lubricants.
  - Shared `validateProductAttributes` is the one rule. Both seller routes (create and PATCH) run it against the category's definitions and answer 422 `invalid_attributes` with `problems` (`required | unknown | type | option`). Numbers typed as text are stored as numbers.
  - The listing wizard asks for the category's attributes on the confirm step (definitions from `GET /api/v1/mart/categories?attributes=<slug>`). The product page shows them above the free-form specs.
  - **Facets.** Facetable attributes of the current category become chips (`a.<key>=<value>`, server-rendered links like the other filters). Counts come from the category's active listings; a chosen facet keeps its siblings visible. Shared `parseAttributeFilters` accepts only facetable keys and legal values; the list query applies them as one jsonb containment on the GIN-indexed column. The products API takes the same params for "show more".
- **N39 dual mode.**
  - A Services | Goods switch (`ModeSwitch`, a SegmentedControl) sits above the search field on `/services`, `/app/search` and the Mart header. It renders only when `MART_ENABLED` and carries the query across.
  - Strong goods results (≥ 3) show a "Make to order" strip: the goods RFQ (ADR-007) prefilled with the query and category. Weak results (< 3) show the prefilled goods RFQ card after the grid; zero results keep the existing empty state with the same link.
- **Acceptance.** `mart:acceptance` runs the new `verify-mart-storefront` (N39 + N40 now; E16b / E16c add N41–N44) and, on a local DB, the 0069 killtest. `verify-mart-inert` checks `/services` renders no switch with the flag off.

**As built (E16b: seller promises, non-returnable and ITC-ineligible categories; same staged 0069).**
- **N41 promises.**
  - The seller opts in per product on the listing wizard: "Ships in 48 h", "Return shipping covered", "GST invoice within 24 h" (`products.promises`, shared `martPromisesSchema`; unknown → 422).
  - **Measured, never money.** The hourly Mart cron (`pool-close`, still inert with the flag off) runs `measureGoodsPromiseBreaches` over goods orders from the last 14 days. Shared `measurePromiseBreaches` decides:
    - *Ships in 48 h*: the first dispatch photo is on the order within 48 h of placement. No photo once 48 h have passed is a breach.
    - *GST invoice within 24 h*: the invoice document named at dispatch is on the order within 24 h of the dispatch photo. Dispatched without one, once 24 h pass, is a breach.
  - Each breach is one row in `mart_promise_breaches` per (order, product, promise), so a re-run records nothing. No order, payout or release-gate value is read or written; `evaluateGoodsReleaseGate` is unchanged.
  - **Badges.** Public reads (list, product, products API) carry only the badges still standing (`withActiveBadges` → shared `activePromiseBadges`). A promise with `promise_breach_limit.count` breaches inside `window_days` disappears. That is a registered `mart_settings` key, default 3 in 90 days. The seller's goods list says which badge is hidden and why.
  - *Return shipping covered* is enforced rather than measured: shared `effectiveReturnFreightPayer` makes the seller the freight payer on that product's return note, whatever the category default.
- **N43 non-returnable and ITC-ineligible.**
  - `mart_categories.returnable` / `itc_eligible` are config, edited in the admin category table (`martCategoryPatchSchema`).
  - **Not returnable** shows on the card, the product page, the cart and checkout lines, and the checkout note. A wholly non-returnable order refuses `open_return` for quality / other with 409 `not_returnable`. Damaged, wrong and short deliveries stay claimable (shared `returnAllowed`), and the workspace offers only those reasons. The release gate's return window is untouched.
  - **ITC.** "ITC may not be available on this item" replaces the ITC hint, and the after-ITC column and card line disappear. The server computes the credit per line (shared `goodsItcSplit`): cart preview, checkout and pool checkout return `itcPaise` (eligible lines' GST) and `afterItcPaise` = total − credit. With every line eligible this equals the taxable value, as before.
- **Acceptance.** `verify-mart-storefront` adds N41 (stored promises, badges, a breach recorded once by the cron with no money or status moved, the badge dropping at the limit while the other stays) and N43 (flags on the product page, a zero-credit preview, 409 on a quality return, a damaged claim opening).

**As built (E16c: samples, customise and the reorder library; same staged 0069).**
- **N42 samples.**
  - The seller may set a sample price on the listing's pricing step (`products.sample_price_paise`, pre-GST; empty = no samples).
  - "Request a sample · ₹X + GST" opens `/app/mart/checkout?sample=<id>`: one unit, outside the cart (the cart is untouched).
  - The one goods preparation (`prepareGoodsCheckout(…, { sample: true })`) prices it at the sample price with the MOQ waived and marks the frozen line `sample: true`. Cart preview and checkout accept `sample` only for exactly one listing at qty 1 (else 422 `sample_one_unit`); a listing without a sample price → 409 `no_sample`.
  - The money is the same `computeGoodsOrderAmounts` → session → webhook → order path: a sample is an ordinary goods order.
- **N42 customise.** "Customise" opens the goods RFQ (`?product_id=…&customise=1`) with the spec rows prefilled from the listing's typed attributes, then its free-form specs. The buyer edits them, and sellers quote as with any goods RFQ (D4: provider-priced).
- **N44 reorder library.**
  - `/app/mart/reorder` (and `GET /api/v1/mart/reorder` for mobile) groups the lines of the buyer's completed goods orders by listing (shared `groupPastGoodsLines`; samples and quoted lines left out). Each shows what they paid beside today's server price for the same quantity, flagged when it changed (the N26 rule). "Reorder" puts it in the cart at that quantity; a listing no longer live shows "No longer listed".
  - **Reminder, opt-in.** `POST /api/v1/mart/reorder/reminders` (only for a listing they bought; service role after the buyer's session) stores `mart_reorder_reminders` at their usual interval: shared `usualReorderIntervalDays`, the median gap clamped to 7–365, 30 for a single order. The first reminder comes that long after the last order, or tomorrow if that has passed.
  - The hourly Mart cron sends each due reminder once (in-app, linking the list) and moves it on, guarded on the `next_at` it read.
  - The cart links "Your usual orders".
- **Acceptance.** `verify-mart-storefront` adds N42 (the page offers both; the sample preview and a real sample order at one unit; 422 / 409 refusals) and N44 (the library with then vs today and the change flag; samples excluded; reminder 404 / 14-day interval / overdue → tomorrow; the cron sends once and moves on). `verify-mart-inert` covers `/app/mart/reorder` and both reorder routes.

---

### E17: Analytics consent (N36, gated: D-UX2)

**The question for counsel:** under India's DPDP Act and its Rules, does first-party, pseudonymous product analytics (PostHog) need consent, or is it a legitimate use?

**If consent is needed**
- A one-line notice at the bottom with **equal Accept and Decline buttons**: same size, same weight, nothing pre-ticked. Unlike Xometry's Accept-only banner.
- **PostHog doesn't initialise until Accept.** Today it loads after idle.
- **Decline** means no analytics events. Counsel confirms that server-side operational events (payment captured, order created) aren't analytics.
- **Storage:** `users.analytics_consent` for signed-in users; a first-party cookie for visitors.
- **Versioning:** the notice is versioned the way legal documents are (`effectiveLegalVersions`).
- **Managing it:** a "Privacy choices" row in the profile.

**If consent isn't needed:** a paragraph in the privacy policy, and no banner.

**Either way**
- WhatsApp and marketing opt-ins are never pre-ticked.
- The §2.3 metrics are computed from server events wherever possible, so a decline rate doesn't blind the funnel. The consent rate is reported as its own metric.

**RICE:** not ranked; this is compliance. **E 0.5.**

**As built (E17, dark: build flag `NEXT_PUBLIC_ANALYTICS_CONSENT_REQUIRED`, default off; migration 0068; the "consent needed" branch, ready for D-UX2).**
- **Off (today).** Nothing changes: PostHog loads after idle, no notice, and `/api/v1/me/analytics-consent` is 404.
- **On.**
  - PostHog does not load, capture or buffer anything until the person accepts. Declining sends nothing and opts out a loaded client.
  - The notice is one line at the bottom with **equal Accept and Decline** (same variant, size and weight; nothing pre-ticked). It links to the privacy policy.
- **Storage.**
  - A first-party cookie `amc_analytics_consent=<choice>.<version>` (one year).
  - For signed-in people, also `users.analytics_consent { choice, version, at }`, written only by `POST /api/v1/me/analytics-consent` (service role; own session, never a delegated token). A signed-in person on a new device gets their stored choice applied without being asked again.
- **Versioning.** Shared `ANALYTICS_NOTICE_VERSION`. A choice for another version counts as not asked (`currentConsentFromCookie` / `currentConsentFromRecord`).
- **Managing it.** A "Privacy choices" row on the buyer profile shows the current choice and changes it.
- **Metrics.**
  - The consent rate is its own metric (`analyticsConsent` in the admin KPI), counted from stored choices by shared `consentRate`, never from analytics.
  - Server-side operational events keep flowing, pending counsel's confirmation that they aren't analytics.
- **If counsel says consent isn't needed:** leave the flag off and add the privacy-policy paragraph. No code changes.
- **Tests.** Shared unit tests (cookie / record versioning, consent rate) and rig `e17` (off: route 404, no notice; on: store / read / 422).

---

## 7. Cross-cutting requirements

### 7.1 Internationalisation
- Every string goes through `next-intl` (hard rule 3).
- A buying-path flag can't reach 100 % until its te and ta keys pass `i18n:coverage` (E14).
- Database text uses `i18nTextSchema` maps.

### 7.2 Accessibility
- **Baseline (§3.8):** WCAG 2.2 AA, 7:1 body text.
- **Touch targets:** ≥ 44 × 44 pt on iOS / web touch, and 48 dp on Android.
- **Motion:** `prefers-reduced-motion` turns springs into fades; `prefers-reduced-transparency` turns materials solid.
- **Screen readers:** every stat reads with its sample ("96 percent on time, based on 126 orders"). Every chart has a table equivalent.
- axe: zero critical and zero serious, on public and logged-in surfaces.

### 7.3 Performance
- The §3.8 budgets, enforced in CI:
  - Lighthouse (mobile) on 6 key pages: home, search, service page, package, checkout, requirement;
  - a per-route JS size check.
- **Self-host the Noto fonts** with `next/font/local` in E1. This removes the build-time Google Fonts fetch that flaked the axe job (PR #29), and keeps `display: optional`.
- This PRD must not regress the Phase 8 done criteria: k6 p95 < 800 ms.

### 7.4 Security and privacy
- **RLS on every new table** (listed in Appendix B), each with a `verify-authz` criterion.
- **Masking:** `redactContactInfo` on every new free-text surface the other party can see (order messages, bundle notes).
- **No personal data in analytics:** ids only. No phone, email, name or GSTIN in event properties.
- **Rate limits (Upstash)** on every new write or compute route: the views beacon, search feedback, order messages, quote preview, checkout preview, the buy-again lookup.
- **The service-role key stays server-only** (hard rule 1).

### 7.5 Money
- **Only 4 items change amounts:** E12a, E12b, E12c and N27b. Each comes with its ADR and a money-rig criterion.
- **Every other epic must leave every amount unchanged:** the money rigs stay green with no edits.
- **Display:** N16's `display` is computed by `computeOrderAmounts`.
- **The lint rule `amclub/no-client-money-math`** blocks arithmetic on `*Paise` anywhere in client components.

### 7.6 State machines
- **No new order states in v3** except any an E12 ADR proposes (extended, never repurposed; §8.4).
- `nextAction` reads `ORDER_STATUSES` from `state-machines.ts`. No status literals anywhere else.

### 7.7 Analytics taxonomy
- **Names:** snake_case `object_action`.
- **Properties:** typed with Zod in `packages/shared/src/analytics-events.ts`, a new file that is the one registry.
- Every new event is added to DESIGN.md Appendix A in the same PR.
- **Server events** (money, notifications) are sent from the server, never inferred from the client.

### 7.8 Testing

| Layer | What |
|---|---|
| Playwright journeys (CI) | new buyer: Buy now → OTP → pay; search → requirement → compare → accept → pay; the order workspace to completion; provider onboarding; inbox → quote |
| axe (CI) | every public page + the logged-in fixtures |
| Visual review | Playwright screenshots of the `/dev/ui` gallery in both densities and 4 languages. Reviewed by a person; they don't fail the build |
| Motion review | a checklist per release: durations within budget; reduced motion honoured |
| Money rigs | unchanged, plus the E9, E12 and N27b criteria |
| `verify-authz` | the criteria each epic lists |
| Unit (shared) | `nextAction`, `rfqQualityScore` parity, `stateFromGstin`, `quoteOptionsSchema`, `compareQuotes` with options |

### 7.9 Flags
- **Naming:** `exp_v3_<area>` in PostHog, evaluated on the server for SSR, so there's no flicker.
- **Rollout:** 10 % → 50 % → 100 %, with a kill switch.
- **Cleanup:** a flag is removed 2 weeks after reaching 100 %.
- Money and agent items keep their existing gates as well.

### 7.10 Agent slots
- **Every slot this PRD names stays dark:** the review summary (P22), `rfq_enrich`, Munshi inline, content translation, and fit %.
- Each needs `AGENT_ENABLED` + `agents_enabled.<name>` + a cohort, and follows ADR-008 / ADR-009 and the `docs/agents/ARCHITECTURE.md` §7 checklist.
- **Every human confirmation writes `ai_decisions`.**

### 7.11 Documentation
- **FRONTEND.md v3:** §3 of this PRD, when E1 is approved.
- **DESIGN.md §8:** records each approved epic.
- **DESIGN.md Appendix A:** the new events.
- **Runbooks for the new crons:** quote SLA, view counts, licence reminders, declared-vs-actual, shadow resolve.

### 7.12 Migrations
- Additive, each with a rollback note and a backfill plan in its PR.
- Numbered at build time.
- Mart ones are marked `staged`.

---

## 8. Release plan and what it displaces

### 8.1 Waves

| Wave | Weeks | Epics | Person-weeks | Exit criteria |
|---|---|---|---|---|
| **0: Fix + foundation** | 1–2 | E0, E1 (with self-hosted fonts) | 5.5 | E0 acceptance passes; the shells + nav at 10 % behind `exp_v3_shell`; the `/dev/ui` gallery complete in 4 languages |
| **1: Buy** | 3–6 | E3, E4, E2, E5 | 12 | Lighthouse ≥ 90 on search and package; search → checkout measured against the Wave 0 baseline; money rigs unchanged |
| **2: Ask + supply** | 7–10 | E6, E9, E10, E11, E7 | 12.5 | RFQ → quote measured; onboarding step funnel visible; `verify-rfq` criterion 5 (loss labels) green |
| **3: Deliver + reach** | 11–14 | E8, E13, E14, E15 | 13 | Order messaging passes `verify-authz`; te/ta at 100 % on the buying path; the provider mobile checklist passes |
| **ADR track** | from week 3 | E12a → E12b → E12c; N27b (D3) | 6.5 + 1 | Writing first. Each is built only after its ADR is accepted, then flagged like any epic |
| **Gated** | — | E16 (Launch Gate), E17 (counsel), agent slots (their gates) | 3.5 | Their own gates |

**Capacity.**
- The waves hold ~43 person-weeks: **3 parallel streams for 14 weeks.**
- With one builder plus Claude sessions, the same order stretches to about **20–24 weeks**. **The order doesn't change**, because each wave's exit criteria feed the next.
- **The whole PRD, including the ADR track and gated epics, is ~53 person-weeks.**

**Rollout per epic:** 10 % → 50 % → 100 %.
- **Guardrails watched at each step:** refund rate, dispute rate, checkout error rate, p75 LCP and support tickets per order.
- A guardrail breach turns the flag off first; the diagnosis comes after.

### 8.2 What it displaces
- **The agent programme's S4.x stages pause until Wave 1 exits.** S3.3 is already blocked on H7. The dark agent slots in this PRD are its hand-off points.
- **It doesn't displace:**
  - money-path hardening;
  - H7 (Razorpay test keys) and H8 (the Fly deploy), which are operations;
  - the Mart Launch Gate work.
- **The pilot (Phase 9):** Waves 0–1 are what the pilot's first buyers see. Waves 2–3 can ship during the pilot, behind flags.

### 8.3 RICE ranking

| Rank | Epic | RICE | Effort (pw) | Wave |
|---|---|---|---|---|
| 1 | E0 Fix first | 1.20 | 1.5 | 0 |
| 2 | E5 Checkout v3 | 0.72 | 1 | 1 |
| 3 | E10 Provider onboarding v3 | 0.42 | 1.5 | 2 |
| 4 | E4 Packages and honest pricing | 0.37 | 3 | 1 |
| 5 | E6 Requirements v3 | 0.33 | 3 | 2 |
| 6 | E3 Trust made visible | 0.32 | 4 | 1 |
| 7 | E2 Discovery | 0.28 | 4 | 1 |
| 8 | E7 Compare v3 | 0.27 | 1.5 | 2 |
| 9 | E9 Homes and retention | 0.22 | 2.5 | 2 |
| 10 | E8 Order workspace v3 | 0.21 | 4 | 3 |
| 11 | E1 Design system + shells | 0.18 | 4 | 0 (enabler: first despite its score) |
| 12 | E11 Provider workspace v3 | 0.18 | 4 | 2 |
| 13 | E14 Language | 0.16 | 2 | 3 |
| 14 | E12a Add-ons | 0.15 | 2 | ADR |
| 15 | E15 Data foundations | 0.13 | 3 | 3 |
| 16 | E12b Speed tiers | 0.12 | 2 | ADR |
| 17 | E13 Mobile parity | 0.10 | 4 | 3 |
| 18 | E12c Bundles | 0.08 | 2.5 | ADR |
| 19 | E16 Mart storefront v2 | 0.06 | 3 | Gated |
| — | E17 Consent | not ranked | 0.5 | Gated |

**Why the waves don't follow the ranking exactly:**
- **E1 comes first** although it scores 0.18: every later surface is built from its components and shells.
- **E3 and E2 come before E6:** buyers must trust and find providers before a better requirement form matters.

---

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The v3 shell regresses performance (materials, springs, a bigger bundle) | Medium | High | §3.8 budgets in CI; materials off on low-memory devices; the per-route JS check blocks merge |
| "Apple calm" and "1688 density" pull against each other; the result is either sparse or cluttered | Medium | High | The density-facts table (§3.3 B) is an acceptance test per surface; moderated tests per wave; Compact is opt-in |
| Public stats are noisy at small n and punish new providers | High | Medium | Sample gates; show n beside every stat; "New on AMClub" instead of empty stats; D1 governs |
| Order messaging becomes a channel for contact exchange | Medium | High | `redactContactInfo` on the stored body; a report button; no message text in WhatsApp; leakage attempts tracked as a guardrail |
| Bundle escrow runs into payment-aggregator rules | Medium | High | ≤ 3 months prepaid in v1; counsel + Razorpay sign-off inside ADR-XC before build |
| Speed tiers get gamed (an inflated Express premium) | Medium | Low | Coherence rules in Zod; on-time % measured per option; buyers compare across quotes |
| Add-ons creep the price up | Low | Medium | ≤ 3 per package; the total always shown from the server; "Most chosen" computed, never provider-set |
| Machine translation mistranslates provider content | Medium | Medium | Provider approval per language; "View original"; numbers copied, never translated |
| Voice search mis-hears | Medium | Low | A per-language eval gate; the transcript is shown and editable before search |
| The obligations checklist reads as legal advice | Medium | High | Routing only; sourced and CA-reviewed rows; the 95 % precision gate; the footer line; D-PRD5 |
| A Mart edit breaks services queries (the 2026-09-09 class) | Low | High | `(mart-*)` route groups; staged columns only via `staged-columns.ts`; `mart:static`; services suites run against prod after merge |
| Scope creep beyond the survey | Medium | Medium | Every epic has RICE and a founder approval; NOT-NOW items listed in §2.2 are refused |
| One builder, many waves | High | Medium | Waves are ordered by value; flags let partial waves ship; the ADR track runs as writing, not building |
| A flaky external fetch in CI (fonts) | Medium | Low | Self-hosting in E1 |

---

## 10. Decisions required

| # | Decision | Recommendation | Blocks | Who |
|---|---|---|---|---|
| **D1** | Show individual measured stats to buyers? (ADR-010 says buyers never see a number) | **Yes, individual stats above sample gates; never the composite.** Needs an ADR-010 amendment | E3 stats, E7 reliability sort | Founder |
| **D2** | A free, earned "buyer verified" signal on RFQs for providers? | **Yes:** Udyam/GSTIN verified + ≥ 1 paid order; fan-out unchanged | E11 badge | Founder |
| **D3** | Let GST-exempt providers onboard with PAN? | **Yes for credential services**, after ADR-XD and the CA's §52 / §9(5) answer | E10 PAN path | Founder + CA |
| **D4** | Mart custom work: platform- or provider-priced? | **Provider-priced** + guidance bands | E16 | Founder |
| **D5** | A paid phone consult as an entry product? | Worth its own §8.1 mini-PRD; **not in v3** | — | Founder |
| **D6** | Delay compensation | Inside ADR-011 (first-order guarantee) | P46 | Founder |
| **D7** | Price display | **Done in this PRD:** "₹X + 18 % GST = ₹Y", from the server (N16) | — | — |
| **D8** | Can our fees be claimed under MSME schemes? | Ask the CA | Marketing only | CA |
| **D9** | Tender/GeM alerts: free or paid? | **Free for verified providers**; alerts only; its own §8.1 | E11 tenders | Founder |
| **D10** | Binding arbitration for high-value disputes? | Not yet; record it | — | Founder |
| **D-UX1** | Directed quote requests (from a provider's page)? | **Not in v3.** Needs a §8.1: it changes matching and fairness | E6, E9 | Founder |
| **D-UX2** | Does DPDP need an analytics consent notice? | Ask counsel; E17 has both branches ready | E17 | Counsel |
| **D-PRD1** | Ship dark mode? | **Not at launch.** Tokens are defined; light is the default for shop-floor sunlight | E1 | Founder |
| **D-PRD2** | Call RFQs "Requirements" everywhere buyers see them (URLs renamed, old ones redirect)? | **Yes.** Providers keep "RFQs", their trade term | E1, E6 | Founder |
| **D-PRD3** | Native provider onboarding on mobile instead of the web wizard in a browser? | **Yes**, sharing the E10 schemas | E13 | Founder |
| **D-PRD4** | The order of the ADR track | **Add-ons → speed tiers → bundles**, by RICE and risk | E12 | Founder |
| **D-PRD5** | Build the obligations checklist and renewal reminders? | **Yes to reminders; the checklist only after the CA's 50-profile eval** reaches 95 % precision | E9 N45 | Founder + CA + counsel |
| **D-PRD6** | Use must-haves in fan-out matching? | **Not in v3.** Display only; revisit with fit % data | E6 | Founder |
| **D-PRD7** | Numerals in Indic locales | **Latin digits everywhere**, Indian grouping, words in script | E14 | Founder |

---

## Appendix A: Traceability

### A.1 Report 2 defects → epics

| Defect | Epic |
|---|---|
| U1 checkout lost at signup | E0 (FR-0.1) → E5 (N1 inline auth) |
| U2 "member price" never applied | E0 (FR-0.2) |
| U3 buy box below the FAQs on phones | E0 (FR-0.3) → E4 |
| U4 no CTA above the fold on the provider page | E0 (FR-0.4) → E3 |
| U5 10 raw state codes | E0 (FR-0.5) → E2 (N4) |
| U6 no nav in logged-in web | E0 (FR-0.6) → E1 |
| U7 no messaging after payment | E8 (N24) |
| U8 mobile provider stats hard-coded | E0 (FR-0.7) → E13 |
| U9 "Top Rated" never set | E0 (FR-0.8) → E3 (D1) |
| U10 two free-text boxes | E0 (FR-0.9) → E6 |
| U11 reviews capped at 10 | E0 (FR-0.10) → E3 (N13) |
| U12 size band unused | E0 (FR-0.11) → E9 (N45 input) |

### A.2 Survey top 10 and runners-up → epics

| Survey item | Seen at | PRD item | Epic |
|---|---|---|---|
| 1. RFQ strength meter | IM-18, AB-04 | N19 | E6 |
| 2. Measured outcome stats | Alibaba, 1688, IndiaMART, Fiverr | N9 | E3 (D1) |
| 3. Verified business buyer | IM-27/29 | N28b | E11 (D2) |
| 4. Paid add-ons | FV-07 | N15 | E12a |
| 5. Compliance bundles | VS-01, IndiaFilings | N18 | E12c |
| 6. "Needs advisor" | VS-07 (gap) | N45 | E9 (D-PRD5) |
| 7. Speed tiers | XM-04, MG-04 | N21 | E12b |
| 8. Mart dual mode | 16-01/05, MG-03 | N39 | E16 |
| 9. Tender/GeM alerts + checklist | IndiaMART, MSME Mart, GeM | N30 | E11 (D9) |
| 10. Reorder library | XM-09, Industrybuying, Udaan | N26, N44 | E9, E16 |
| Search relevance thumbs | IM-07 | N6 | E2 |
| Failed search → RFQ | IM-08 | N7 | E2 |
| AI review summary (verified reviews only) | FV-12 | P22 slot | E3 (dark) |
| Verification checklist with dates | IM-25/26 | N10 | E3 |
| "Funded ✓" badge | Upwork | N37 | E8 |
| Stage-wise photo evidence | Zetwerk | Work tab milestones | E8 |
| Category-tiered return windows | Industrybuying, Udaan | N43 | E16 |
| Forward-to-purchaser approval | Xometry | Not in v3; recorded for a team-accounts PRD | — |

### A.3 Foundations → epics
F1 → E7 + E15 · F2 → E6 · F3 → E15 · F4 → E3 + E15 · F5 → E2 + E15 · F6 → E15 · F7 → E9 · F8 → E16 · F9 → none · F10 → E15.

### A.4 Anti-patterns → where the PRD rules them out

| Anti-pattern | Rule |
|---|---|
| Spam calls sold back to buyers | Numbers masked until payment (unchanged); no "View number" anywhere |
| Fake urgency | §3.7: no urgency theatre; deadlines only when they're real, with their consequence |
| Drip fees | N16: the full "₹X + GST = ₹Y" from the first card; no fee appears first at checkout |
| Pre-ticked consent | E17: nothing pre-ticked; equal Accept / Decline |
| Unearned "AI" labels | Agent slots stay dark until their evals pass; nothing is labelled AI that isn't |
| Narrow "protection" | The escrow promise stated once, plainly; ADR-011 for more |

### A.5 Refused (NOT-NOW, §8.3)
- AI negotiation (Alibaba AI Mode, the compare-tray "AI negotiate").
- Reverse-auction RFQs (Alibaba sellers, GeM RA).
- "Request a discount from several suppliers" (Amazon Business), including the "capped single-round" variant.
- Pre-order provider chat (Fiverr "Contact me", TradeIndia "View Number", IndiaMART "Call Now").
- Paid rank labels that look like quality badges (IndiaMART STAR / LEADING).

---

## Appendix B: New schema and API

**Tables and columns** (all additive; RLS on every table)

| Object | Epic | Access |
|---|---|---|
| `msme_profiles.size_band` | E0 | owner |
| `users.ui_density` | E1 | owner |
| `search_feedback` | E2 | service role writes |
| `recent_views` | E2 | owner |
| `categories.parent_id` (existing; used from here on) | E2 | public read |
| `provider_public_stats` | E3 | public read of approved rows; service role writes |
| `provider_verifications` evidence columns | E3 | as today |
| `provider_profiles.next_available_on`, `capacity_slots`, logo moderation state | E3 | owner writes; public read |
| `package_groups`; `packages.group_id`, `tier`, `ideal_for_i18n`, `compare_values` | E4 | provider owns; public read |
| `categories.govt_dependent`, `packages.govt_dependent_override` | E4 | admin / provider |
| `service_document_requirements` | E6 | public read of reviewed rows; admin writes |
| `rfqs.must_haves` | E6 | as `rfqs` |
| `quote_events` `lost` rows | E7 | as `quote_events` |
| `order_messages` (or `conversations.kind = 'order'`) | E8 | parties + admin; insert through the route only |
| `buyer_licences`, `obligation_rules` | E9 (D-PRD5) | owner / public read of reviewed rows |
| `onboarding_nudges`; `provider_profiles.gst_registered`, `pan_verified_at` | E10 | service role / owner |
| `view_counts_daily` | E11 | service role writes; own rows |
| `tender_alerts`, `tender_feedback` | E11 (D9) | verified providers / owner |
| `package_addons`; `orders.addons` | E12a | provider owns; parties read |
| `quote_options`; `quotes.selected_option_id` | E12b | as `quotes` |
| `bundle_milestones`, `bundle_purchases`; `orders.bundle_purchase_id` | E12c | provider owns / parties read |
| `rfqs.cad_features`, `packages.deliverables`, `orders.attribution` | E15 | as their tables |
| `search_queries`, `service_synonyms`, `shadow_predictions` | E15 | service role / public read of reviewed synonyms / service role |
| `mart_category_attributes`, `mart_categories.returnable` (staged) | E16 | Mart rules |
| `users.analytics_consent` | E17 | owner |

**Routes** (all Zod-validated; every write route rate-limited)

| Route | Epic |
|---|---|
| `GET /api/v1/me/actions` | E1, E9, E11 |
| `GET /api/v1/search/universal` | E1 |
| search v2 parameters on the existing search routes | E2 |
| `POST /api/v1/search/feedback` | E2 |
| reviews: cursor pagination | E3 |
| `display` on the catalog, package and checkout payloads | E4 |
| `POST /api/v1/checkout/preview` | E4, E12a |
| `/api/v1/orders/[id]/messages` (GET / POST) | E8 |
| `GET /api/v1/orders/[id]/buy-again` | E9 |
| `POST /api/v1/rfq/[id]/quote/preview` | E11 |
| `POST /api/v1/views` | E11 |
| `GET /api/v1/partner/insights` | E11 |
| accept with `optionId` | E12b |

**Crons:** quote SLA (E6), view counts roll-up (E11), licence reminders (E9), declared-vs-actual (E15), shadow resolve (E15), onboarding stall (E10).

---

## Appendix C: Analytics event catalogue

All snake_case `object_action`. Server events are marked (s). Properties are in each epic's table.

| Area | Events |
|---|---|
| Fix-first | `signup_intent_restored`, `provider_cta_clicked` |
| Shell | `nav_item_clicked`, `megamenu_item_clicked`, `command_search_opened`, `universal_search_performed`, `density_changed` |
| Discovery | `search_performed`, `search_filter_changed`, `search_zero_results`, `search_voice_used`, `search_feedback_given`, `search_to_requirement_clicked`, `service_page_viewed`, `recent_view_opened`, `shortlist_added`, `compare_opened` |
| Trust | `provider_profile_viewed`, `trust_panel_expanded`, `verification_item_opened`, `stat_tile_info_opened`, `reviews_loaded` |
| Packages | `package_viewed`, `tier_selected`, `compare_matrix_viewed`, `buy_now_clicked`, `refund_policy_opened` |
| Checkout | `checkout_viewed`, `checkout_inline_auth_started`, `checkout_inline_auth_completed`, `checkout_itc_shown`, `payment_initiated` |
| Requirements | `requirement_form_started`, `requirement_voice_used`, `requirement_strength_changed`, `requirement_document_toggled`, `requirement_must_have_set`, `requirement_submitted` |
| Compare | `compare_viewed`, `compare_sorted`, `compare_flag_viewed`, `quote_shortlisted`, `quote_accepted`, `quote_declined`, `quote_lost_labelled` (s) |
| Orders | `order_viewed`, `order_next_action_clicked`, `order_tab_viewed`, `order_message_sent`, `order_message_read` |
| Home | `home_viewed`, `home_action_clicked`, `home_pickup_clicked`, `buy_again_clicked`, `requirement_repeated`, `licence_added`, `renewal_reminder_sent` (s), `obligation_checklist_viewed` |
| Onboarding | `onboarding_step_viewed`, `onboarding_step_completed`, `onboarding_gstin_autofilled`, `onboarding_abandoned` (s), `onboarding_nudge_sent` (s), `onboarding_submitted` |
| Provider | `partner_home_viewed`, `partner_action_clicked`, `inbox_filter_changed`, `inbox_sorted`, `quote_form_started`, `quote_preview_shown`, `quote_submitted`, `insights_viewed`, `tender_alert_opened`, `tender_alert_feedback`, `gem_checklist_viewed` |
| Value extensions | `addon_toggled`, `checkout_addons`, `quote_option_added`, `quote_option_selected`, `bundle_viewed`, `bundle_purchased` (s), `bundle_milestone_completed` (s), `plan_cancel_requested` |
| Language | `locale_changed`, `translation_viewed_original`, `content_translation_approved` |
| Foundations | `corpus_consent_changed` |

*End of PRD.*
