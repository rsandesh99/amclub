# WhatsApp readiness audit — 2026-09-26

**Question:** can our architecture carry the founder's WhatsApp strategy (market research report "AMClub WhatsApp Strategy", 25 Sep 2026: build our own layer directly on Meta's Cloud API, no BSP), and which features will users expect on top of it?
**Scope:** master `1ecc652` — `packages/agent-core/src/whatsapp`, `apps/agent-runtime` (webhook, dispatcher, agents), `apps/web/lib/notifications`, the agent routes and consent, Mart and pools, mobile, the i18n and legal copy, migrations 0030 / 0036 / 0041 / 0045 / 0079.
**Method:** six read-only auditors in parallel (transport, consent and privacy, the assistant, commerce and campaigns, user expectations, a web fact-check of the report), then every High finding re-checked by hand in the code. Meta's own pages were blocked by this environment's egress proxy, so the Meta facts below come from search results that quote Meta's documentation and from several independent secondary sources. Each is marked, and each should be confirmed with one click on Meta's page before it goes into configuration.

## Verdict

**The direction is right and most of the plumbing already exists — but the architecture is not safe to switch on with a live number today.**

- **About 60 % of what the report plans is already built, dark.** A Meta Cloud driver; a signed, de-duplicated webhook with a store-then-queue pipeline and a minute sweep; the 24-hour window tracker; capped media download; START / STOP; ~45 registered templates; interactive reply buttons and lists; four agents on WhatsApp (onboarding, Digital Munshi, Support, Procurement) on the same runner, with `ai_decisions` confirm gates and the M42 one-proposal rule. No agent path moves money.
- **Eight blockers must be fixed before any live number** (section 1). Three of them would make the launch visibly fail: Telugu users would receive no templates at all, providers' WhatsApp agents are wired to the wrong persona, and STOP does not stop order messages.
- **The report is wrong about our architecture in ten places** (section 2) — hosting, cost, what W1/W2 involve, payments in chat, and several Meta facts that changed in 2025–26, one of them five days from now (service and in-window utility messages become chargeable on **1 Oct 2026**).
- **Users will expect ~30 things the report does not list** (section 5). Nine are launch-critical: an in-app WhatsApp switch at signup, a STOP that stops everything, SMS fallback, deadline reminders, refund / dispute / verification notices, one-tap deep links, a HELP menu, an "official AMClub" safety page, and a person who can actually reply.
- **Found in passing and fixed in this PR:** 20 write routes accepted delegated agent tokens (section 7), including the Mart goods transition (`accept_delivery` schedules a payout) and `/agent/grants` (a token could widen its own scopes).

## 1. Blockers before any live WhatsApp number

Each was confirmed by reading the code; file references are to master `1ecc652`.

| # | Blocker | Evidence | Consequence | Fix |
|---|---|---|---|---|
| B1 | **STOP does not stop order messages, and order messages need no opt-in.** | `packages/agent-core/src/whatsapp/templates.ts:91-95` (`WA_ALWAYS_ALLOWED_KINDS`), `apps/web/lib/notifications/channels.ts:103`; the settings copy says so (`apps/web/messages/en.json:1645`: "Order and payment updates are sent regardless of opt-in") next to a "Stop WhatsApp updates" button | Breaks Meta's opt-in / opt-out policy and DPDP withdrawal; blocks and reports then throttle the number. No opt-in is captured at signup, so these go to people who never agreed. | A phone-level suppression every send checks (all kinds); a versioned WhatsApp opt-in at signup and in settings (web + mobile); decide the post-STOP policy (D-WA1). |
| B2 | **Telugu users get no templates.** A kind without a `_te` name falls back to the `_en` name but is sent with language `te`. | `templates.ts:104-108` returns `names[locale] ?? names.en`; `meta-cloud.ts:52` sends `language.code = LANG[locale]` | Meta addresses a template by name **and** language, so the pair does not exist (error 132001, inferred — not run against Meta). Every order, RFQ, payout, opt-in, opt-out and holding template fails for Telugu users — the pilot cluster. Tamil has no WhatsApp locale at all (`types.ts:13`). | `templateFor` returns the name and language it actually resolved; submit `_te` and `_ta` variants; a unit test per locale. |
| B3 | **Providers' WhatsApp grants have the buyer persona.** | `apps/agent-runtime/src/whatsapp/inbound.ts:449` picks `buyer` when `roles` includes `msme`; every account starts as `{msme}` (`packages/db/src/schema/identity.ts:14`) and provider signup appends `provider` (`api/v1/profile/provider/route.ts:131`); Munshi looks only for a `provider` WhatsApp grant (`apps/web/lib/agent/munshi.ts:78-86`) | Munshi drafts never reach WhatsApp; the WhatsApp onboarding interview's voice answers and draft confirmation get 403 `no_provider_grant`. The rigs don't catch it: they create providers with roles `['provider']` only. | One channel consent per phone, separate from agent delegation (or a grant per role held); backfill; rigs with real roles. |
| B4 | **Greetings count as consent; "no" and "cancel" unsubscribe from everything.** | `templates.ts:113-117` (`hi`, `ok`, `yes`, `namaste` = opt-in), `:125-129` (`no`, `cancel`, `नहीं`, `వద్దు` = opt-out); the ledger always records `keyword: 'START'` (`inbound.ts:466`) | Consent evidence is wrong (DPDP needs a clear affirmative act). A buyer typing the label of our own "No" button, or "cancel" about an order, loses every WhatsApp grant, Munshi and procurement scopes included. The founder required this fixed before any WhatsApp cohort (2026-09-23, `docs/FOLLOWUPS.md`). | Opt-in only on START or a button; opt-out only on STOP / UNSUBSCRIBE words (en / hi / te / ta) or a payload; record the real keyword and message id. |
| B5 | **The Graph API version has expired.** | `meta-cloud.ts:27` defaults to `v20.0`; `WHATSAPP_GRAPH_VERSION` is not validated in `lib/env.ts` | Per Meta's versioning guide (via search), v20.0 reached end of life on **24 Sep 2026**; calls are silently served by v21.0, which ends 21 Jan 2027. Webhook payload shapes follow the version. | Pin v24+ (v26 is current) through validated env; a scheduled check that warns 90 days before expiry. |
| B6 | **Sends from the web app are invisible.** | `channels.ts:99-111` writes no `wa_messages` row; failures only reach `console.warn` (`create.ts:131-133`); `meta-cloud.ts:41` flattens every Graph error to text | Delivered / read / failed callbacks match nothing; error codes (131026 not on WhatsApp, 131047 outside window, 131049 marketing limit, 131050 user stopped marketing, 130429 rate limit) are lost, so nothing can suppress, fall back, retry or count cost. | One send service in agent-core used by web and runtime: consent + suppression check, window decision, an outbound row written before the call with an idempotency key, classified errors, monotonic statuses. |
| B7 | **No cost ledger, and chat stops being free on 1 Oct 2026.** | Status callbacks drop `pricing` (`inbound.ts:133-136`); no per-message cost anywhere | From 1 Oct 2026 (Meta, via search; confirmed by several providers): non-template service replies are free only for the first 1,000 per number per month, then ₹0.115 each; utility templates inside the window are no longer free. Every assistant reply and confirm-gate card costs money. | Record `pricing.category` / `billable` per message; integer rate registry (paise per 1,000 messages, rule 6); a monthly WhatsApp budget beside the model budget. |
| B8 | **The assistant only serves users who existed on 24 Sep.** | `cohort_user_ids` is a list of at most 500 ids (`packages/shared/src/agent-settings.ts:104-108`) | Everyone who signs up from now on gets the holding reply on WhatsApp and no Help on mobile (`apps/mobile/app/(app)/profile.tsx:75`). | A registered `cohort_mode` (`list` / `all`) honoured by the runtime and `agentAvailability` — a founder decision (D-WA2). |

Smaller must-fix items before a live number: `metadata.phone_number_id` is not checked, so a second number on the same Meta app would be ingested as ours (`meta-cloud.ts:106-145`); a driver named without credentials silently becomes the stub (`whatsapp/index.ts:69-70`); runtime sends carry no timeout (`apps/agent-runtime/src/deps.ts`), against the "every outbound fetch carries a timeout" rule; template parameters are not cleaned of newlines (Meta rejects them — `support/index.ts:216-218` sends multi-line text); inbound `from` is reduced to digits (`meta-cloud.ts`), which would corrupt a business-scoped user id (see 2.9).

## 2. Where the report is wrong or out of date

| # | The report says | What is true | Source |
|---|---|---|---|
| 2.1 | The webhook is a Vercel route (`/api/v1/whatsapp/inbound`); no own hardware; running cost ≈ 0 | The webhook is `POST /webhooks/whatsapp` on the always-on **Fly runtime** (Hono + pg-boss, `bom`), because inbound needs the queue worker and the agents (ADR-009 §2). Real running costs: Fly, Upstash, Sarvam (speech), model calls. WhatsApp secrets live on both Vercel and Fly. | `apps/agent-runtime/src/server.ts:115-130` |
| 2.2 | W1 "only touches the notification channel that is already stubbed" | The WhatsApp channel is a live-capable Meta driver; **the SMS channel is the stub** and never sends, even with a key (`channels.ts:84-90`). W1 touches agent-core, the runtime, migrations and the web dispatcher. | code |
| 2.3 | W2 (router, voice, confirm buttons) is 2–3 weeks of new work | Largely built and dark: dispatcher, four agents, button gates, `ai_decisions`, the M42 binding, Sarvam speech-to-text. What is missing is one router, an `off_topic` path, the unknown-number path and fixes (section 4). | code |
| 2.4 | Utility templates are free inside the 24-h window; service replies are free | **From 1 Oct 2026** utility templates inside the window cost ₹0.115, and service replies are free only for the first 1,000 per number per month (then ₹0.115). Every rate is **+18 % GST**. Utility / authentication list at ₹0.115; no ₹0.145 figure was found. Marketing is ₹0.8631 since 1 Jan 2026. | Meta pricing docs via search; several providers, Sep 2026 |
| 2.5 | Unverified accounts: 250 conversations a day; verified start at 1,000 and climb to 100,000 | Limits count **unique users reached by templates outside a window, per rolling 24 h, per business portfolio** (shared by all numbers, since 7 Oct 2025). 250 unverified; verification now goes straight to **100K** (the 2K / 10K tiers were removed in 2026). A separate marketing number adds no capacity. | Meta messaging-limits docs via search; Wati, 360dialog 2026 |
| 2.6 | A red quality rating cuts sending | Since Oct 2025 quality no longer lowers the limit; it blocks upgrades. What bites is template-level: pacing, pausing, and utility templates auto-approved as **marketing** (since 9 Apr 2025), announced by the `template_category_update` webhook. | Meta docs via search |
| 2.7 | "Accept quote ₹5,900 from Lakshmi Tax? Yes / No" as an in-chat confirm | Conflicts with ADR-008 and S3.1: the procurement grant holds neither `accept_quote` nor `place_order`; "go with B" yields a decision-bound link to the app's own confirm sheet, where the buyer pays under their session. Keep it that way. | `packages/shared/src/procurement.ts:55` |
| 2.8 | Flows support any UPI app for payment steps; payment in chat | Flows collect data; in-chat payment is the separate **Payments API – India** (`order_details` + a Razorpay / PayU / UPI-intent configuration). That, or a Razorpay Payment Link, creates a gateway order that is not one of our `checkout_sessions`: `capture_payment()` answers `unknown_session` and **no order is created** (`0078_payment_truth.sql`). The only entry compatible with "one money path" is a link to our own pay page, which mints the session when opened. Anything else needs an ADR amending ADR-027. | Meta payments docs via search; `apps/web/lib/payments/materialize.ts:78` |
| 2.9 | Identity is the phone number | Meta is rolling out **business-scoped user ids** (BSUIDs): since ~Apr 2026 every messages webhook carries `user_id`, and a user with a WhatsApp username may arrive with no phone number at all. India's username rollout is paused by a MeitY notice (1 Jul 2026), so the risk is latent here — but our parser strips non-digits from `from`, which would turn a BSUID into a bogus phone and bind it to whoever holds those digits. Store `user_id` beside the phone; refuse a non-numeric `from` for binding; OTP templates still need a phone. | Meta BSUID docs via search |
| 2.10 | "Never train on chat data" | Meta's Business Solution Terms are broader: WhatsApp data, **including anonymous, aggregate or derived forms**, may not be used to create, train or improve any model (a narrow exception for a model used exclusively by the business). Eval sets and golden conversations must not be built from WhatsApp traffic. The general-purpose-AI ban applied to new accounts from 15 Oct 2025 and to all from 15 Jan 2026; "primary vs incidental" is Meta's sole judgement, so the code-level scoping the report asks for is the right control. | whatsapp.com/legal/business-solution-terms (via search) |

Also: the currency of a WhatsApp Business Account cannot be changed later, and non-INR accounts of Indian portfolios reportedly stop delivering after 31 Dec 2026 — **create the production account in INR from day one**. Groups (max 8 members, no buttons) are unsuitable for pools; the report's pool-card design is right. Coexistence (providers keeping their own number) requires becoming a Tech Provider with Embedded Signup v4, and exposing a provider's number to buyers conflicts with §8.3 (no provider chat before an order). The calling API is generally available and allowed in India, but calling a user needs a permission template first. DESIGN §2.2 and CLAUDE.md still name Gupshup / Interakt for WhatsApp; going direct needs the §8.1 mini-PRD and a DESIGN update.

**Corrected cost model** (the report's assumptions: 8 utility + 2 marketing templates per active account per month; now with GST, before any assistant replies):

| Scale | Accounts | Meta charges / month incl. 18 % GST | The report said |
|---|---|---|---|
| Pilot | 500 | ≈ ₹1,560 | ≈ ₹1,400 |
| Design target | 10,000 | ≈ ₹31,200 | ≈ ₹27,000 |
| Regional | 100,000 | ≈ ₹3.1 lakh | ≈ ₹2.7 lakh |
| National | 1,000,000 | ≈ ₹31 lakh | ≈ ₹27 lakh |

Per account: 8 × ₹0.115 + 2 × ₹0.8631 = ₹2.65, × 1.18 = ₹3.12. Assistant conversations add ₹0.136 (incl. GST) per reply beyond 1,000 replies per number per month — a six-reply voice RFQ costs about ₹0.81. Marketing still dominates, so the per-user marketing cap remains the main lever; the second lever is batching confirm cards so one message carries one decision.

## 3. What exists today (the map)

| Layer | State | Where |
|---|---|---|
| Driver | Meta Cloud (templates with body params, text, reply buttons ≤ 3, lists ≤ 10, capped media download, HMAC verify, GET challenge); Interakt; stub | `packages/agent-core/src/whatsapp/*` |
| Webhook | Signed, raw-body HMAC; store → 200 (500 on a store failure so Meta retries); de-dup on `vendor_message_id`; pg-boss job id = message id; minute sweep; `/health` reports the worker | `apps/agent-runtime/src/server.ts`, `whatsapp/inbound.ts` |
| Conversation store | `wa_conversations` (one row per phone, `window_open_until`), `wa_messages` (in + runtime out); admin / ops read only | migrations 0030, 0079 |
| Identity binding | Owner re-derived from `users.phone` on every message; a phone change unbinds and revokes (trigger 0079) | `whatsapp/binding.ts` |
| Consent | `agent_grants` with `channel = 'whatsapp'` doubles as Meta opt-in **and** agent delegation | `inbound.ts:445-468` |
| Templates | ~45 kinds, en / hi (some te), body params only, names in code | `templates.ts`, `docs/PRE_LAUNCH_CHECKLIST.md` 1.3 |
| Dispatcher | STOP → media → onboarding session → Munshi buttons → procurement → free text vs open proposals (M42) → opt-in words → JOIN → Support → holding reply | `inbound.ts:213-317` |
| Agents | Onboarding (provider interview), Munshi (quote drafts), Support (classifier + templates; the model writes no user text), Procurement (voice / photo → request, compare, "go with B" link) | `apps/agent-runtime/src/agents/*` |
| Voice | Sarvam `saaras:v3` speech-to-text via `/api/v1/rfq/voice-parse` under the delegated token; TTS web-only | `apps/web/lib/voice/*` |
| Delegation | Runtime HMAC → `/api/v1/agent/token` → ≤ 15-min JWT bound to a run; RLS applies; admin refused | `apps/web/lib/agent/token.ts` |
| Web notifications | In-app always; email live; SMS stub; WhatsApp templates for the kinds each call site lists | `apps/web/lib/notifications/*` |

Built well: signature, de-dup, sweep and replay safety; the phone-binding rules (M41); media caps and the opt-in gate on downloads (M34); the one-proposal rule (M42); code-level scoping (the Support classifier has no reply field; off-topic falls to a template); no money path reachable from any agent.

## 4. The report's features, one by one

| Feature | Status | Gap to a working WhatsApp feature |
|---|---|---|
| Transactional updates with one-tap buttons | Partial | Only ~15 of ~50 notification kinds ask for WhatsApp; 13 kinds have a template nobody requests (`order_delivered`, `order_accepted`, `payout_paid`, `rfq_new_quote`, the buyer's payment receipt …); Mart pool kinds request WhatsApp but have no template; no template can carry a button (`meta-cloud.ts:50-53` sends body params only). |
| Confirm gates as buttons | Built (dark) | Needs B3 / B4 fixed; Interakt cannot do buttons. |
| Unknown number → onboarding | Missing | Unknown numbers get one holding template a day. Creating an account from WhatsApp (phone possession as verification) is an auth decision → ADR. |
| Known user → one assistant, persona by role | Partial | A first-match chain of agents with fixed personas; greetings are eaten by the opt-in words; two off-topic or failed classifications open a human ticket and silence the agent (`agent-core/src/support/core.ts:123-141`). Needs one router and an `off_topic` intent with a steer-back that does not escalate. |
| Voice-note request in Telugu | Partial | Works inside procurement for the cohort after the buyer enabled it on the web; a two-hop start; notes over 30 s fail at Sarvam because the duration passed is a fixed 20 s (`procurement/agent.ts:179`); one voice flow makes four rate-limited calls. Transcribe once per message and cache it. |
| Photo → request | Partial | Only inside an active procurement session; as a first message a photo gets the holding reply; scanned PDFs fail (`pdf_no_text`). |
| Provider quotes from chat | Partial, broken on WhatsApp by B3 | Drafts are proactive only; the provider cannot start a quote from chat. |
| Group buys | Missing on WhatsApp | No pool templates, no `join_pool` tool, the pay-on-close notice goes by email / in-app only. |
| Order evidence and one-tap receipt | Missing | `sendMedia` needs a public URL; no `confirm_receipt` / `record_dispatch` tools. Receipt feeds the goods release gate → ADR + money-rig criterion. |
| Compliance calendar | Licence expiry only (dark) | GST / annual filing calendar is at the V1.5→V2 gate (§1.7, §8.2) and waits on D-PRD5 (counsel). |
| Founder's inbox | Built (notices) | Correctly link-only; acting stays a console click. |
| Marketing / campaigns | Missing by design | "Transactional only" is written into the code and DESIGN §5.5; needs §8.1 + a marketing consent separate from `agent_grants`. |
| Template registry, quality watch, spend | Missing | Names only in code; no category, approval state, Meta webhooks for template status / category / quality, or spend. |
| Flows, catalog, payment links | Missing | See 2.8 for payments; catalog prices can never be the charge (tiers, MOQ, per-line GST) — re-price on the server. |
| Calling API, TTS out | Missing | Own §8.1 + ADR (A3+ telephony). |

## 5. Addendum — what users will expect

**P0 = needed at WhatsApp launch.**

| # | Feature | Who | P | Today |
|---|---|---|---|---|
| 1 | WhatsApp opt-in as a checkbox at signup and a toggle in settings (web **and mobile**), not "type START" | all | P0 | wa.me START link on web profile only, hidden when `AGENT_ENABLED` is off; nothing on mobile |
| 2 | STOP stops everything; scoped stops later ("STOP LEADS") | all | P0 | Broken (B1) |
| 3 | SMS fallback when WhatsApp fails or the user is not on WhatsApp | all | P0 | SMS is a permanent stub; web sends aren't logged, so failures can't trigger anything |
| 4 | Deadline reminders: accept-by (24 h auto-cancel), review-by (72 h auto-accept), RFQ expiring with quotes waiting, quote expiring, payment pending, pool pay-by | all | P0 | None (DESIGN §5.9 promises 24 / 48 h reminders) |
| 5 | Money and outcome notices: refund initiated / processed, dispute resolved, payout credited with UTR, payout held, provider verification approved / rejected with reason | all | P0 | Dispute resolution and verification decisions notify nobody; payout notice by email only, rounded to whole rupees |
| 6 | One-tap deep links that open the exact screen (in the app when installed) | all | P0 | Links in body text on 4 kinds; no Android App Links |
| 7 | HELP / MENU keyword with a fixed list (track order, my requests, talk to a person, language, stop) for everyone, no model | all | P0 | Only the cohort gets Support; others get the holding reply |
| 8 | "Official AMClub on WhatsApp" page: our numbers, display name, domain; we never ask for OTP, UPI PIN or payment to a personal UPI | all | P0 | Missing; two different numbers are in use (company line on help / grievance vs the bot number) |
| 9 | A person can reply in the same thread (business-hours auto-reply with ETA) | all | P0 | Ops can acknowledge, assign or resolve with a note; no reply box; the agent is silent while a ticket is open |
| 10 | Change language by typing its name; one language across web, mobile and WhatsApp | all | P0 sync / P1 keyword | Mobile signup never sends a locale; switchers don't persist; the conversation locale is frozen |
| 11 | DPDP requests by WhatsApp and in the app (my data, correct, delete, withdraw) and a retention schedule for chats and media | all | P0 intake | The privacy page promises retention; no purge job exists; `wa_conversations` survives user deletion (`ON DELETE SET NULL`) |
| 12 | Mute per category and choose the channel per category (transactional set locked) | all | P1 | No preferences model; channels are hard-coded per call site |
| 13 | Quiet hours in IST (21:00–08:00 default; urgent kinds bypass) | all | P1 | Ops only |
| 14 | Daily digest instead of real-time (providers' leads) | provider | P1 | Missing |
| 15 | Pause alerts for N days | provider | P1 | Boolean `capacity_paused` only |
| 16 | Lead alert with Interested / Not interested / Quote buttons | provider | P1 | `rfq_matched` has no buttons |
| 17 | Order actions by button (provider accept / decline; buyer raise issue); approving delivery goes to the app's confirm sheet | all | P1 | Missing |
| 18 | Reply to order messages from WhatsApp (masked relay) | all | P1 | `order_message` carries only the title, by design |
| 19 | Documents in chat: GST invoice, quote PDF, order summary | all | P1 | Invoices exist but carry "TEST MODE" and drop Indic text (section 7) |
| 20 | WhatsApp on a number other than the login phone (office phone, second SIM) | all | P1 | Binding requires `users.phone` |
| 21 | Phone-number change flow; recycled-number protection (Meta's "user changed number" system message; dormant accounts re-confirm) | all | P1 | Trigger ready (0079), no flow; system messages parsed as `unknown` |
| 22 | Several people of one business get updates | all | P1 | One user per business; needs an auth ADR |
| 23 | Tamil on WhatsApp and in the mobile app | all | P1 (P0 for a Tamil cohort) | Missing |
| 24 | Redact an OTP / UPI PIN / card number a user types; warn them | all | P1 | Raw text stored |
| 25 | REPORT keyword for a suspicious message | all | P1 | Missing |
| 26 | Conversation history in the app (WhatsApp support turns) | all | P1 | Procurement mirrored; Support only in admin |
| 27 | App push as a second channel | all | P1 | Missing (web and mobile) |
| 28 | Voice replies for low-literacy users | all | P2 | Web only |
| 29 | Missed-call callback for feature phones | all | P2 | Missing |
| 30 | Per-user communication timeline in admin (every channel with its status) | ops | P1 | Only a ticket's last 50 messages |

**Collisions with the NOT-NOW register — do not build:** "Message this provider on WhatsApp" or a provider's number on a profile (no provider chat before an RFQ / order); Counter / "can you do ₹4,000?" buttons (no per-buyer negotiation; ADR-013); "lowest quote so far" to providers (no bidding wars); streaks, points or badges for fast replies (no gamification); WhatsApp Communities or Channels (no social feed); video consults; paying a provider's UPI in chat or cash on delivery; non-+91 numbers; approving delivery or releasing money by a typed reply (ADR-008 / ADR-026).

## 6. Consent, privacy and Meta policy

Legal points state the requirement as we read it; counsel must confirm them.

| Requirement | State | Gap |
|---|---|---|
| Opt-in before any business-initiated message (Meta Business Messaging Policy; DPDP "clear affirmative action") | Partial | Order and payment kinds go without any opt-in (B1); greetings count as opt-in (B4); no opt-in at signup, checkout or in the mobile app. |
| Opt-out honoured everywhere, and as easy as opting in (Meta; DPDP s.6(4)) | Partial | STOP revokes grants but order templates continue (B1); no Tamil STOP words; a STOP from an unknown number is not recorded; the web toggle disappears when `AGENT_ENABLED` is off. |
| Provable consent per number and purpose (source, time, notice version, scope) | Partial | `agent_grants.consent` holds locale, surface and a text version, but the keyword is always "START", there is no purpose split (transactional / assistant / marketing), and the same row is also the agent's delegation, so withdrawing WhatsApp messages also withdraws the assistant. |
| Marketing consent separate from service messages | Missing | No marketing path exists (by design until §8.1). |
| Scope of the assistant (Meta, Jan 2026) | Enforced in code | The Support classifier returns an intent only; replies are templates; procurement and Munshi output is clamped (`customerFacingText`, `clampProviderMessage`). Gap: no `off_topic` intent, and two off-topic turns escalate to a human and silence the agent. |
| No model training on WhatsApp data (Meta Business Solution Terms, incl. derived / aggregate data) | Not written down | Nothing trains today, but nothing forbids building eval sets or golden conversations from `wa_messages`, and the model / speech providers' retention settings are not recorded. Add the rule to `docs/agents/SECURITY.md` and the privacy notice; record zero-retention settings per provider. |
| Retention and erasure (DPDP s.8(7)) | Missing | No purge for `wa_messages` or the `wa-media` bucket, though the privacy page promises a schedule; text from people who never signed up is kept indefinitely; deleting a user leaves the phone and chat (`ON DELETE SET NULL`). |
| Notice (DPDP s.5) | Partial | The privacy notice should name WhatsApp / Meta as a processor, cross-border processing, the assistant and voice processing (Sarvam), and the retention period. |
| Grievance path reachable from WhatsApp | Partial | A grievance page exists (web only); no keyword, and mobile has no grievance entry outside the cohort. |
| Recycled numbers (telcos reissue numbers after ~90 days) | Partial | Binding follows `users.phone`, so a reissued number that is still some old user's phone receives that user's order updates; Meta's "user changed number" system message is ignored. Dormant accounts should re-confirm before WhatsApp binding. |
| Sensitive data typed into chat (OTP, UPI PIN, card) | Missing | Stored raw; add patterns to the one contact masker and redact before storing. |
| Access to chats | Built | `wa_conversations` / `wa_messages` are admin / ops read only; no client grant; media in a private bucket behind signed URLs. Ops reads are not audit-logged. |

## 7. Found in passing

**Fixed in this PR — delegated agent tokens on write routes no tool wraps.** Audit wave 3 made delegation deny-by-default, but 20 write handlers were missed, all reachable with a Bearer token:

- **Mart** (live since 2026-09-24): goods transition (`accept_delivery` completes the order and schedules the payout; `cancel` refunds), checkout, pool join / leave / checkout, reorder reminders, and the seller product, image, draft and activation routes.
- **`/agent/grants` POST / DELETE**: a delegated token could write a new grant for itself with scopes the design withholds (`place_order`, `accept_quote`), or manufacture a WhatsApp consent row.
- `/agent/onboarding/start`, `/legal/accept` (an agent accepting terms for a user), `/reviews/[id]/reply` and `/flag`, `/saved`, `/notifications/read`, `/partner/packages` POST and `/partner/packages/[id]` PATCH / POST / DELETE.

Exploiting any of these needed a delegated token (the runtime secret or a runtime bug), so this was a missing defence layer rather than an open door. Each handler now calls `requireNotDelegated` first. `verify-authz` §10 probes the non-agent routes for an exact 403; `verify-mart` F2 probes the Mart routes and the consent route on the production-flags server and checks the order did not move.

**Open, not WhatsApp-specific (for the next wave):**

| Severity | Where | What |
|---|---|---|
| Medium | `apps/web/lib/invoices/generate.ts:54` | Every invoice prints "Provisional GST structure — pending CA sign-off. TEST MODE." while production takes real payments, and Indic names print as `?`. Removing the line needs the CA's sign-off (D-WA7). |
| Medium | `packages/shared/src/support-copy.ts:85, 157, 229, 301` | The Support agent tells providers AMClub takes "only 5 % commission" in all four languages. Services commission is per category, default 10 % (seed 8–12 %); only Mart defaults to 5 %. |
| Medium | `apps/web/app/api/v1/rfq/[id]/quote/route.ts:251-258` | A new quote (and a revised or withdrawn one) reaches the buyer only by SMS, which is a stub: buyers learn of quotes only inside the app. |
| Medium | `apps/web/lib/disputes/resolve.ts`, `api/v1/admin/verifications/[id]/route.ts` | Dispute resolution and provider verification decisions notify nobody, though the copy promises the verification notice. |
| Medium | `apps/web/lib/mart/pools.ts:788-845` | `pool_met` ("pay your share by …") requests WhatsApp and SMS but has no template and SMS is a stub; a member who misses it is recorded as defaulted. Its copy is hard-coded (the Hindi slot holds English). |
| Medium | `apps/mobile/app/(app)/profile.tsx:75` | Mobile shows Help only to agent-cohort users: everyone else has no contact or grievance path in the app. |
| Medium | `apps/mobile/app/(auth)/signup.tsx`; `LanguageSwitcher.tsx`; `inbound.ts:178` | Language never reaches the server from mobile or the header switcher, so Hindi and Telugu users get email and WhatsApp in English. |
| Low | `apps/web/lib/notifications/events.ts:278` | A payout of ₹1,234.56 is announced as ₹1,235. |
| Low | `apps/web/lib/notifications/channels.ts:41` | Links fall back to `amclub-web.vercel.app` when `NEXT_PUBLIC_APP_URL` is unset. |

## 8. Recommended build

Each phase is one or more PRs in the usual way (flag, i18n, PostHog, rig criteria); money-adjacent items need their ADR first.

**W0 — make it safe (before any live number; ~2 weeks).**
1. §8.1 mini-PRD + DESIGN §2.2 / §5.5 / §5.9 update (Meta direct; the notification ledger) and **ADR-030 "WhatsApp on the Cloud API: consent, suppression, outbound ledger"**.
2. Consent ledger separate from agent delegation (phone, scope transactional / assistant / marketing, source, text version, the real keyword, message id); signup and settings opt-in on web and mobile; STOP honoured for every kind and for unknown numbers; the keyword fixes (B1, B3, B4).
3. Template language fix + `_te` / `_ta` variants + tests (B2); Graph version pin + env validation + fail-loud driver + `phone_number_id` check (B5).
4. One send service with the outbound ledger, error classification, bounded retry, monotonic statuses, cost capture and parameter cleaning (B6, B7); runtime timeouts.
5. BSUID-safe parsing; cohort mode (B8, after D-WA2).

**W1 — transactional launch (~2–3 weeks).** One event → channel registry replacing per-call arrays, with WhatsApp on every order, RFQ, refund, payout and dispute kind; templates with URL buttons and typed parameters (order number, server amount, IST dates); the notification outbox with retries (closes audit M37) and MSG91 SMS fallback (DLT); reminder crons; verification / dispute / refund notices; HELP menu; official-channel safety page; admin WhatsApp console (delivery log, templates synced from Meta, quality and tier, spend); preferences and quiet hours.

**W2 — the assistant on WhatsApp (~3 weeks).** One router in agent-core; `off_topic` intent with a steer-back; voice pipeline (real duration, one transcript per message, its own limiter); photo / PDF as a first message → intake; enabling procurement from WhatsApp; Munshi quotes started from chat; Tamil; ops replies from `/admin/support`; the conversation mirror; decision-route hardening (the run must match the token's run).

**W3 — commerce (~3–4 weeks, after its own §8.1).** Pool templates and pay-on-close links (our pay page only); goods receipt and dispatch tools (ADR, money-rig criterion); Flows for address and goods RFQ; catalog sync behind a flag (server re-prices every cart); click-to-WhatsApp attribution and PostHog events; campaigns with separate marketing consent, a per-user cap and an integer cost preview.

**Later.** Account creation from WhatsApp (auth ADR); WhatsApp OTP fallback (auth ADR); TTS out; the calling API (own §8.1 + ADR); team accounts.

## 9. Decisions for the founder

| # | Decision | Recommendation |
|---|---|---|
| D-WA1 | After STOP, do order and payment updates still go on WhatsApp? | No. STOP stops all WhatsApp; those updates continue by SMS, email and in-app. Opt-in at signup covers transactional messages for everyone else. |
| D-WA2 | Who gets the assistant on WhatsApp? | Everyone who opted in (`cohort_mode = all`), with the non-AI HELP menu as the floor; or keep the frozen list and accept that new users get the menu only. |
| D-WA3 | Marketing on WhatsApp in V1? | Not before W3 and its §8.1: transactional first protects the number's standing. If yes: separate consent, 2 per user per week, never to non-members. |
| D-WA4 | Meta account set-up | Create the WhatsApp Business Account **in INR**, complete business verification, a dedicated number, and decide which number is "official" (the company line or the bot) so users see one. |
| D-WA5 | Retention of chats and media | For example 180 days for text, 90 for media, unless attached to an order or dispute; confirm with counsel. |
| D-WA6 | WhatsApp OTP when SMS fails | Useful and cheap (₹0.115 vs SMS), but it is an auth change: ADR first. |
| D-WA7 | Invoice "TEST MODE" line | Needs the CA's sign-off on the GST structure; then remove it. |

Also still open from 2026-09-24: `obligations_enabled` (licence reminders) is presumably on in production under "every boolean switch is true" without the D-PRD5 counsel sign-off it waits on; and the bundles / tenders question (audit L6).
