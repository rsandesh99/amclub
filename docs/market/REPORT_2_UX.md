# Report 2 — UX comparison: structure, density, flows, and the best-of-the-best AMClub experience

*AMClub market survey, September 2026.*

**Sources:**
- **Competitors:** the walked portal reports in `raw/` (IndiaMART, Alibaba, TradeIndia, Vakilsearch, Moglix, Fiverr, Xometry, 1688, MSME Mart), plus the public-page reports where they describe UI.
- **AMClub:** a count of every page, nav item, filter, dropdown, form field and step, taken from the code at `507a1dc`. Dark features are marked. The inventory is summarised in §2 and §3.

**Companion:** `REPORT_1_FEATURES_AND_MOAT.md`.

**Caveat on competitor numbers:** they are **observed minimums** from 10–45-minute sessions. A competitor may have more screens than listed. Click counts are approximate and exclude logins and bot checks.

---

## 1. The verdict

**AMClub's transaction flows are the tightest surveyed.**
- A logged-in buyer goes from search to the Razorpay window in **4 clicks**, and from a quote to payment in **2 clicks** plus a confirm sheet.
- Checkout is one screen.
- Neither Fiverr (a drawer, then a payment page) nor Moglix (cart → delivery → address → pay) is that short, and IndiaMART has no checkout at all.

**Everything around those flows is thinner than the market:**
1. **The logged-in web app has no navigation.** The buyer and provider shells have zero nav links; you move only through dashboard tiles. The mobile app has 5 bottom tabs, and the web app should match it.
2. **Trust is invisible at the point of choice.** The result card shows initials instead of a photo and no measured stats. The provider page's only above-the-fold button is **Save**; there's no "Buy" or "Get a quote" up top. On phones the buy box renders *below the FAQs*.
3. **Filters are dropdowns where they should be taps.** All 44 dropdowns in the web app are native `<select>`s, and most have 3–5 options. The search state filter offers 10 raw codes ("AP", "TS") while the header offers all 37 states by name. There's no category filter on results.
4. **The storefront doesn't sell.** One package per page (no tiers), no "choose this if", no add-ons, no refund line on the package, and a "member price" that checkout never applies.
5. **The conversion leaks are real bugs** (§4):
   - a **new** buyer who clicks Buy Now signs up and lands on the dashboard, and the checkout is gone;
   - there's no messaging after payment (the PRD's M6 promises it);
   - the mobile provider dashboard shows hard-coded "0".

**The market's best patterns worth taking:**

| From | Pattern |
|---|---|
| **Fiverr** | Package tiers + a comparison matrix + priced extras; a personalised home ("pick up where you left off") |
| **IndiaMART** | A live RFQ strength meter; one-tap city chips; a failed search that turns into a requirement; a seller verification lookup |
| **Alibaba** | Measured stats on every card (reorder %, on-time %, response time); a compare tray |
| **1688** | "Buy now" vs "make to order" tabs on one query; service-promise filters |
| **Moglix** | The price with its GST split and input tax credit (ITC) in rupees at checkout |
| **Vakilsearch** | "Choose this if…" on each tier |
| **Xometry** | A quoting dashboard with tabs, a part library and CSV export; three price/speed options |

**The market's worst patterns to keep avoiding:**
- **IndiaMART:** spam calls after an RFQ, and trust badges for sale.
- **TradeIndia:** countdown timers, and "View Number".
- **Vakilsearch:** a lead form behind a price.
- **Fiverr:** a buyer fee revealed only at checkout.
- **Alibaba:** a pre-ticked box sharing your business card.

AMClub has none of these today, and that is worth protecting.

---

## 2. Structure at a glance

| Dimension | IndiaMART | Alibaba | TradeIndia | Vakilsearch | Moglix | Fiverr | Xometry | 1688 | **AMClub (web, live)** |
|---|---|---|---|---|---|---|---|---|---|
| Page types seen | 14 (+7 found, not opened) | 8 (+6) | 7 | 6 | 6 | 5 | 4 | 2 | **56 live** (26 buyer, 14 provider, 16 admin) + 25 dark |
| Global nav | Search with mic + camera; buyer nav incl. Loans, Credit score | 4 home tabs (AI Mode / Products / Manufacturers / Worldwide) | Search + AI search + mic | Mega-menu (~12 groups + tools, calculators) | Deals home, city list | Category bar | 4 dashboard tabs | 6 mode tabs | **2 links + 2 selects** (state, language) public; **0 nav links** logged in |
| Search filters | City chips + related chips; advanced search (4 controls) | ~11 facet groups (Trade Assurance, verified, rating, samples, MOQ, certs…) | 5 toggles + business type (5) + city chips | Autocomplete only | 6 facet groups | 5 menus + 2 toggles | n/a | 8 sort tabs + 10 promise toggles + ~16 attribute facets | **5 selects + 1 toggle**; no category filter; state = 10 raw codes |
| Result-card elements | Price, 3 CTAs, GST tick, TrustSEAL, response % | 9 (price range, MOQ, reorder %, years, country, rating, verified, sponsor, coupon) + select box | Approx. price, MOQ, city, View Number, Send Inquiry | — | Price, MRP, % off, rating | Level, rating, "from" price, Ad tag, heart | — | Repeat %, visits, "peers watching", rank, BNPL, custom tag | **8** (initials, name + tick, credential, rating, Top Rated, title, 4 chips, price block). No photo, no save |
| Listing / detail | Spec table + seller card with 8 firmographics + response %, histogram | Tier table, sample, variants, customisation levels, supplier card with 5 metrics | — | 3 tier cards + "Choose this if" | Price with GST split, tier chips, pincode, insights, 7 trust tiles | 3 package tabs + matrix + extras drawer + FAQ + AI summary | 9 config fields + 3 price/speed options | — | 1 package; included/excluded, deliverables, requirements, FAQ; buy box sticky only on desktop |
| RFQ form | 10 fields + 0–100 meter + AI chat + voice + camera | 5 fields (3 required) + AI spec generator + 2 pre-ticked boxes | WhatsApp link | Lead modal (3 fields) | Bulk form + 30-minute callback | Brief (blocked) | CAD upload → auto-quote | — | **category + title + 4–5 template fields + notes + budget + date** (4–5 required); **voice live**; photo/CAD and pre-check dark |
| Checkout | None (off-platform) | Trade Assurance (not walked) | TI Pay (opt-in) | Lead form | Cart → delivery tier → address → GST/ITC → coins → coupon → fee → pay | Drawer → payment page (fee + GST) | Checkout (not walked) | — | **1 screen: breakdown + optional GSTIN → Pay** (2 clicks from Buy now) |
| Provider onboarding | 2 steps (GSTIN auto-fill or PAN) | — | — | — | — | — | — | — | **5 steps**, 9 required inputs + 2 verifications (up to 18 with credentials) |
| Provider inbox | 8 tabs + 5 filter groups (lead console) | — | Buy-lead list | — | — | — | Job matching | — | **3 tabs**, no filters, search or sort |
| Buyer home | RFQ replies, feed, photo-RFQ card, verification, plans | AI Mode banner | Value-add cards | Hero AI search | Deals | Resume, saved, brief CTA, profile progress | 4 tabs + CSV | — | Greeting, banner, completeness bar, 5 tiles, 3 recent orders |
| Unprompted popups | Plans upsell | Trial banners, CAPTCHA | Countdown on every package | Lead modal, WhatsApp opt-in pre-ticked | Coins | Bot check | Cookie "Accept" only | CAPTCHA | **Legal-acceptance modal only**; no cookie banner |

---

## 3. Surface by surface

For each surface: what the best competitor does, what AMClub does today (from the code), and the recommendation.

### 3.1 Navigation and information architecture
**Competitors:**
- **Vakilsearch:** a mega-menu of ~12 groups plus free tools; heavy, but you can find anything in two hovers.
- **1688:** puts the *mode* first (find goods / find a factory / find a service…), 6 tabs.
- **Alibaba:** does the same with 4 tabs led by AI Mode.
- **Xometry:** a logged-in dashboard with 4 tabs: Quotes · Orders · Tools · Part library.

**AMClub today:**
- **Public header:** logo, "Browse services", "Become a provider", a **state `<select>` with 38 options**, a language `<select>`, Sign in / Sign up.
- **Logged-in web shell (buyer and provider): no nav links.** Logo, bell, avatar menu. Every destination goes through dashboard tiles.
- **Mobile:** has the right idea: 5 bottom tabs (Home, Search, Saved, Orders, Partner).
- `/app/search` exists but nothing links to it.

**Best-of-best for AMClub:**
- **Public header:** logo · **Services** (a mega-menu of 8 categories × top 3 services, no tools clutter) · search field with a mic · **Post a requirement** (primary button) · language (endonyms) · Sign in. When Mart is live, add a 1688-style **Services | Goods** switch.
  - Move the state selector out of the header into search, where it filters.
- **Logged-in buyer (web = mobile):** persistent nav: **Home · Search · Requirements · Orders · Saved** (+ Mart when live). A left rail on desktop and bottom tabs on phones, badges on Requirements (quotes waiting) and Orders (action needed). Keep the bell and avatar.
- **Logged-in provider:** **Home · RFQs (badge) · Orders · Listings · Earnings**, with Reviews and Profile under the avatar.

### 3.2 Search results and filters
**Competitors:**
- **IndiaMART:** one-tap city chips, sibling-category chips, a "Did you find…? Yes/No" question, and an inline "Tell us what you need" RFQ box mid-results.
- **Fiverr:** groups its many options into 5 menus (Category, Service options, Seller details, Budget, Delivery time) plus 2 toggles.
- **Alibaba:** trust toggles (Trade Assurance, Verified) come before attributes.
- **1688:** shows the ceiling: 30+ controls. Powerful for experts, overwhelming for a Tier-2/3 MSME owner.

**AMClub today:**
- One wrapped row: search text, **Sort (4)**, **State (10 raw codes)**, **Price (4 buckets)**, **Rating (3)**, **Language (5)**, **Verified-only** chip. All are native selects except the chip.
- No category filter on results. Filters appear only after a query.
- 24 per page, Previous/Next.
- The empty state's "Post a requirement instead" drops the query and goes to `/signup`.
- **Mobile:** 3 sort chips, verified chip, and a state bottom sheet with all 37 states, which is better than web.

**Best-of-best for AMClub:**
1. **Search bar** with a **mic** (reuse the voice-RFQ speech pipeline) and a **category** scope.
2. **Sibling-category chips** under the bar (≤6; `parent_id` exists).
3. **Primary filter chips, one tap each, ≤5 visible:** Verified · Delivery ≤ N days · Price band · 4★+ · Language. Chips, not dropdowns: every AMClub dropdown here has ≤5 options, so a select costs two taps where a chip costs one.
4. **"More filters" sheet:** State (all 37 **by name**, not codes), City, Credential type, Response time.
5. **Sort** as a compact control at the right.
6. **Result count + relevance thumbs** at the end of page 1 ("Did you find what you need?"), which feeds the search eval set.
7. **Zero or weak results:** an inline box, "Get quotes for '<query>' from up to 7 verified providers — your number stays hidden." It **carries the query** into the RFQ.
8. **Paging:** load-more on phones; numbered pages on desktop.

### 3.3 Result card
**Competitors:**
- **Alibaba:** 9 facts per card, including **reorder rate** and years on platform.
- **1688:** repeat-purchase % on every card.
- **Fiverr:** seller level, a save heart, and the "from" price.
- **IndiaMART:** response %, but also three contact CTAs that leak the lead.

**AMClub today:** 8 elements. Initials avatar (never a photo), name + tick, credential line, rating, "Top Rated" (never set), title, chips (days, revisions, state, "Responds in ~Xh"), price block. No save button.

**Best-of-best: 9 elements, fixed order, no contact CTA:**
1. Photo or logo (initials fallback).
2. Name + verified tick.
3. Credential line.
4. Rating (n) **and one measured stat** ("92 % on time" or "38 % repeat buyers"; D1).
5. Package title.
6. Chips: delivery days · responds in ~Xh · **active this week**.
7. Price block with **"+ GST"**.
8. **Save heart.**

Also: drop "N revisions" from the card (it belongs on the detail page), and never show a paid rank.

### 3.4 Provider profile
**Competitors:**
- **IndiaMART:** a seller card with 8 GST-derived facts (legal status, GST year, turnover band, member since…), response rate, calls-answered %, a rating histogram with Response/Quality/Delivery %, and a buyer-side **seller verification lookup**.
- **Alibaba:** a supplier card with response time, on-time dispatch %, reorder %, rank and years.
- **Fiverr:** orders in queue, online now, repeat-client reviews.

**AMClub today:**
- Header card: initials, name, tick, credential, rating, city, orders done, response time, language codes, up to 13 verification chips, category chips.
- **The only above-the-fold CTA is "Save".**
- Then About, the packages grid, and **the first 10 reviews with no "load more"**.
- No tabs, no sticky CTA, no years of experience (captured, never shown), no "member since".

**Best-of-best:**
1. **Above the fold:**
   - **Identity:** photo, name, credential.
   - **Trust panel:**
     - verification checklist (each check: what, how, date);
     - member since; years in practice; orders completed;
     - response time;
     - on-time % and repeat-buyer % (D1, above sample gates);
     - active this week; next available start.
   - **Primary CTA: "See packages"** (anchors to packages). **Secondary: "Post a requirement in <category>".**
2. **Section tabs/anchors:** Packages · About · Reviews · Credentials.
3. **Reviews:** a histogram (sub-scores once volume allows), a "repeat buyer" marker, and "load more".
4. **Phones:** a sticky bottom bar holding the primary CTA.
5. **Directed quote requests** ("request a quote from this provider") are a product decision. Our RFQ fans out by category and state, and a directed RFQ changes that. Recorded as **D-UX1**.

### 3.5 Package detail and buy box
**Competitors:**
- **Fiverr:** 3 package tabs + a "Compare packages" matrix + an extras drawer (each extra +₹/+days) + FAQ + an AI summary.
- **Vakilsearch:** 3 tier cards, each with "Choose this if…", and a money-back line on the card.
- **Moglix:** the price with its GST split and the MRP, tier chips, a pincode delivery check, 7 trust tiles.

**AMClub today:**
- One package.
- Included/excluded, deliverables, "what we'll need from you", FAQ.
- A buy box with the price, "Plus 18 % GST at checkout" (fixed in PR #28), days, revisions and **Buy now**.
- **Sticky only on desktop. Below the FAQs on phones.**
- No refund line.
- A **"member price" line checkout never applies** (§4).

**Best-of-best:**
1. **Tier tabs** (Basic / Standard / Premium) when the provider groups packages, with a **comparison matrix** and a **"Choose this if…"** line per tier.
2. **Price:** **"₹X + 18 % GST = ₹Y"**, computed on the server.
3. **Add-ons** as checkboxes with +₹ and +days, capped at 3 (needs an ADR).
4. **One line under the price:** "Money held until you accept · Full refund before work starts · Refund policy", linked.
5. **Government-dependent categories:** "Approval depends on the government portal. Your provider's clock pauses while it waits."
6. **Phones:** a **sticky bottom bar**, "₹Y incl. GST · Buy now". This is the most important single fix on this page.
7. **Remove the member-price line** until memberships exist.

### 3.6 Checkout
**Competitors:**
- **Moglix:** 3 screens with a delivery-speed choice, an ITC checkbox ("Claim ₹107 on your input tax credit"), coins, a coupon, and a platform fee revealed last.
- **Fiverr:** a drawer, then a payment page with a service fee + GST revealed there, and "You won't be charged yet".

**AMClub today:**
- One screen: the breakdown (price, discount, taxable value, GST 18 %, total payable), an optional GSTIN (prefilled), and **Pay ₹X**.
- **2 clicks from Buy now to Razorpay.** Best in the survey.
- A logged-out user returns via `?next=`. **A brand-new user loses the checkout** (§4).

**Best-of-best: keep the one screen, and add:**
- **"Claim ₹N as input tax credit"** when a GSTIN is present (Moglix).
- A 3-line **"What happens next"**: provider accepts in 24 h or you're refunded · share requirements · pay out only when you accept.
- The refund line.
- **Fix the new-user path:** OTP inline on the checkout page, or carry `next` through the signup wizard.

### 3.7 Posting a requirement (RFQ)
**Competitors:**
- **IndiaMART:** a **0–100 strength meter** with per-field points and "FILL NEXT"; 10 fields (name, image, specs, location, timeline, payment terms, buyer type, profile, frequency, details); a "Fill using AI" chat with answer chips; mic + camera on the first field; a photo-RFQ card on the dashboard.
- **Alibaba:** one line → an AI-generated spec (standards, packaging, test reports) with Apply / Regenerate / Discard. It **dropped the quantity** field, a lesson worth noting.

**AMClub today:**
- **Voice recorder at the top (live):** 30 seconds → pre-fills category, title and details.
- **Typed path:** category select (8), title (≥10 characters), 4–5 category template fields (33 in total across 8 templates), **two free-text boxes** (template notes + "anything else"), budget min/max, needed-by.
- 4–5 required fields, with **no asterisk on category and title**.
- Draft autosave.
- Photo/PDF/CAD intake and the quality pre-check are dark.
- State comes from the profile, and the page is gated on sector + state.

**Best-of-best:**
1. **Voice first**, as today, with the clarify question switched on.
2. **Category → the template fields appear.** Required fields ≤5, **all marked**.
3. **One** free-text box: merge the template "notes" and "anything else".
4. **A live strength meter** fed by the shared `rfq-quality` rules (the same rules as the server pre-check), with "Add a deadline (+15)".
5. **"Documents you'll likely need"** after the category is picked (from rules; the buyer confirms). For goods, standards and test certificates, carrying the **quantity** as a required typed field.
6. **Budget as bands** (chips) rather than two free numbers; keep "needed by".
7. **A promise block at the bottom:** "Up to 7 verified providers in <state> · quotes within 72 h · your number stays hidden." This is the anti-IndiaMART line.
8. **Entry points** (today there are 2): header button · failed search · provider profile · package page ("Need something different?") · dashboard.

### 3.8 Comparing quotes
**Competitors:** IndiaMART shows a reply card, then chat. Alibaba compares in My Alibaba, with an AI compare tray. Xometry gives three price/speed options per quote.

**AMClub today: already the strongest in the survey.**
- A 12-row attribute table: price, normalised total, delivery, GST, transport, validity, advance, response, completed orders, flags, actions.
- 12 flag kinds, a shortlist, sorting.
- **Accept & pay in 2 clicks** with an escrow explanation.
- A decline sheet with 5 reasons and a preview of the message to the provider.
- On mobile it becomes cards.

**Best-of-best: small additions only:**
- Show the **scope text in the desktop table** (today it's on mobile cards only).
- Switch on the **fair-price line** and **reliability ordering** when volume allows.
- Add **speed-tier columns** when that ADR lands.
- Keep "Message" masked.

### 3.9 Order workspace
**Competitors:** Upwork and Fiverr keep milestones, delivery, revisions and messages together. Zetwerk promises photos at every production stage.

**AMClub today:**
- One long page with 11 sections: payment banner, header with status and deadlines, refund, revision note, actions, requirements, dispute statement, milestones with photos, reviews, documents, timeline.
- Confirm sheets for every action.
- **No messaging after payment.** The PRD's M6 lists "in-order messaging".

**Best-of-best:**
- A **sticky "Next step" bar** at the top with the single primary action for the viewer ("Share requirements", "Accept delivery"…) and its deadline.
- **Section tabs:** Overview · Requirements · Work & milestones · Messages · Documents · Timeline.
- **Messages:** masked, like the quote threads.
- **"Payment secured ✓"** on the provider's view.
- The dispute entry stays a quiet "Report a problem", not a big button.

### 3.10 Buyer home
**Competitors:**
- **Fiverr:** a personalised home ("pick up where you left off", saved, the brief CTA, profile progress).
- **IndiaMART:** an RFQ-reply card, a browsing-driven feed, a photo-RFQ card.
- **Xometry:** a dashboard with tabs and CSV export.

**AMClub today:** a greeting, a CMS banner, a completeness card (<80 %), **5 tiles** (Browse, Post, My requirements, My orders, Saved), 3 recent orders.

**Best-of-best: a task-first home.**
1. **"Needs your action"**: quotes waiting (n), deliveries to accept, requirements to share, payments pending. Each row is one tap.
2. **Pick up where you left off**: the draft RFQ, the last package viewed.
3. **Recent orders.**
4. **Saved providers.**

The tiles move into the persistent nav (§3.1).

### 3.11 Provider onboarding
**Competitors:**
- **IndiaMART:** 2 steps, "I have a GSTIN → auto-verify & fill", or PAN if GST-exempt, and it re-targets drop-outs by the stage they left at.
- **GeM:** a 13-step checklist, but GSTIN is optional.

**AMClub today:**
- **5 steps:** Contact · Business · KYC · Bank · Submit.
- **9 required inputs + 2 verifications**, rising to 18 with credential categories.
- GSTIN is required for every category, and verifying it fills only the legal name.
- The draft is saved.
- **No per-step analytics.**

**Best-of-best:**
- **4 steps:** Contact · Business (GSTIN first, **auto-fills legal name, trade name, state, address**) · Credentials & bank · Submit.
- **≤7 required inputs** for non-credential categories.
- A **"what you'll need" checklist** before step 1.
- **PAN path** if D3 passes.
- **PostHog per step**, with a WhatsApp nudge for drop-outs at a given stage.
- The **"Finish on WhatsApp"** option (dark today) switched on per cohort.

### 3.12 Provider RFQ inbox and quote form
**Competitors:** IndiaMART's lead console has 8 tabs (Relevant, Recent, Export, Catalog views, More leads, Shortlisted, Tenders, Past) and filters for location, category, order value and lead type.

**AMClub today:**
- 3 tabs (Open / Quoted / Closed) with counts, and **no filters, search or sort**.
- Rows show the title, "n / max quotes" and a status badge.
- **The quote form:** price, days, what's included (≥20 characters), GST? (3), transport? (3), valid until, advance %, message. **No asterisks.**

**Best-of-best:**
- **Inbox:** filters for category · state · budget band · closing soon; sort by newest / closing soon; a **"buyer verified"** badge (D2); a **tenders tab** (D9, alerts only).
- **Quote form:**
  - required fields marked;
  - GST and transport as 3-option **segmented controls**, not selects;
  - **speed tiers** when the ADR lands;
  - a **Munshi draft** inline when switched on.

### 3.13 Provider dashboard
**Competitors:** JustDial Business shows views, leads and engagement. IndiaMART sells seller performance reports.

**AMClub today:** a status banner, 3 stats (active orders, completed, earnings), the score card (dark), 5 tiles. **The mobile provider dashboard shows hard-coded "0" / "₹0".**

**Best-of-best:**
- A **"Needs your action"** list: new RFQs matching you, orders to accept, deliveries due.
- **A funnel:** profile views → RFQs matched → quoted → won, with the reasons buyers declined. It must not reveal the AMC Score.
- **Payouts:** scheduled, held, paid.
- The score card when switched on.

### 3.14 Mobile, WhatsApp and language
**Mobile today:**
- **28 screens**, 5 tabs. Buyer flows are close to complete.
- **Missing on mobile:** buyer profile and invoices; **provider listings, provider orders list, earnings, provider profile and reviews**; onboarding opens the web in a browser.
- **Why it matters:** providers run their business from phones (DESIGN persona P2's staff), so provider parity is the bigger gap.

**Language:**
- **Web:** en / hi complete; **te 41 %, ta 18 %** (English fallback key by key). Package titles and category names come from the database in en/hi only, so Telugu and Tamil users see English exactly where buying happens.
- **Competitors:** IndiaMART has voice search in 9 languages and "View in Hindi" machine translation; Vakilsearch has a Hindi toggle; Alibaba AI Mode is English only.
- **Best-of-best:** voice search (§3.2); machine-drafted provider content in hi/te/ta **that the provider approves**; finish te/ta for the buying path first (search, package, checkout, RFQ, orders).

### 3.15 Interruptions and consent
**Competitors:** IndiaMART plan upsells, TradeIndia countdowns, the Vakilsearch lead modal with WhatsApp opt-in pre-ticked, Alibaba trial banners, Moglix coins, the Xometry cookie banner with only "Accept".

**AMClub today:** only the legal-acceptance modal when a document version changes. **No cookie or consent banner, and PostHog loads after idle.**

**Best-of-best:** keep zero marketing interruptions. **Ask counsel** whether India's DPDP Act needs a consent notice for analytics. If yes, add a one-line notice with equal "Accept" / "Decline" buttons, unlike Xometry.

---

## 4. Defects the count turned up (fix before any redesign)

| # | Defect | Where | Impact | Size |
|---|---|---|---|---|
| U1 | **A new buyer's checkout is lost.** Buy Now → login → `/signup?complete=1` → the wizard ends with `router.push('/app')` | `(auth)/login` page, `MsmeWizard.tsx:128` | The first purchase by every new buyer: straight search→checkout loss | S |
| U2 | **"Member price" shown but never applied.** Cards and packages show "₹X for members", but checkout passes only the coupon discount, and memberships don't exist | `PriceBlock.tsx`, `api/v1/checkout/route.ts:183-209` | A misleading price (same class as the GST note fixed in PR #28) | S (hide the line) |
| U3 | **Buy box below the FAQs on phones**, no sticky bar | package page | Mobile conversion | S |
| U4 | **No "Buy" or "Get a quote" CTA above the fold** on the provider page (only Save) | `p/[providerSlug]/page.tsx` | Profile → purchase | S |
| U5 | **The search state filter offers 10 raw codes**, while the header offers 37 states by name | `ListingControls.tsx` | Buyers outside those 10 states can't filter | S |
| U6 | **No nav in the logged-in web shells**; `/app/search` unreachable | `AppShell.tsx` | Every repeat visit | M |
| U7 | **No messaging after payment** (PRD M6) | `OrderWorkspace.tsx` | Coordination moves to phone calls (leakage) | M |
| U8 | **Mobile provider dashboard stats hard-coded "0" / "₹0"** | mobile partner home | Provider trust in the app | S |
| U9 | **"Top Rated" never set**, but rendered and sorted on | `provider_profiles.top_rated` | A dead badge (D1) | S |
| U10 | **Two free-text boxes** on the RFQ form; no asterisk on category/title | `RfqForm.tsx` | RFQ quality | S |
| U11 | **Reviews capped at 10** with no "load more" | provider page | Trust for the best providers | S |
| U12 | **The gateway's size band is collected but not used** | gateway → wizards | Wasted question | S |

---

## 5. The best-of-the-best AMClub, in numbers

**Journey budgets** (clicks exclude typing; competitor figures are approximate):

| Journey | Best seen | AMClub today | Target |
|---|---|---|---|
| Logged-in buyer: search → Razorpay open | Fiverr ≈ 5 (gig → package → drawer → continue → pay); Moglix ≈ 6 | **4** | **4** (keep) |
| **New** buyer: search → Razorpay open | Fiverr: sign-up modal, then back to the gig | **Broken** (lands on the dashboard) | 4 + OTP inline |
| Post a requirement by voice | IndiaMART: AI chat + form | ~30 s speech → review → submit | ≤60 s end to end, ≤1 clarifying question |
| Post a requirement by typing | IndiaMART: 10 fields with a meter; Alibaba: 1 line + AI | 7–9 inputs, 4–5 required, no meter | ≤5 required, a meter, suggested documents |
| Quote → pay | Alibaba: chat → order (off-page) | **2** + confirm sheet | **2** (keep) |
| Provider onboarding | IndiaMART: 2 steps | 5 steps, 9 required + 2 verifications | 4 steps, ≤7 required |
| Provider: RFQ seen → quote sent | IndiaMART: buy lead → call | Open RFQ → 4 required fields | ≤3 fields with a Munshi draft |

**Element budgets** (the rules that keep us from becoming 1688):
- **Filters:** ≤5 primary chips visible; everything else in one "More filters" sheet.
- **Result card:** ≤9 elements, one measured trust stat, no contact CTA, no paid rank.
- **One primary CTA per screen**, sticky on phones.
- **No dropdown with ≤5 options.** Use chips or segmented controls: one tap instead of two. This applies to sort, price, rating, language, GST-included, transport-included, years in practice and sector.
- **Price always with its tax**, computed on the server.
- **Zero unprompted marketing popups.** Only legal gates, and consent if counsel requires it.

---

## 6. UX backlog, ranked

**S = a day or two, M = about a week.**

| Rank | Item | From | Metric | Size | Gate |
|---|---|---|---|---|---|
| 1 | Fix U1 (new-buyer checkout) and U2 (hide member price) | §4 | search→checkout | S | Now |
| 2 | Sticky buy bar on phones (U3) + CTAs on the provider page (U4) | Fiverr, Moglix | search→checkout | S | Now |
| 3 | Persistent nav in the logged-in web shells (U6), matching mobile tabs | Xometry, the mobile app | repeat | M | Now |
| 4 | Filter chips + a full-name state filter (U5) + sibling chips + relevance thumbs + query carried into the RFQ | IndiaMART, Fiverr | search→checkout | S–M | Now |
| 5 | Result card v2 (photo, save, "+ GST", active this week, one measured stat after D1) | Alibaba, Fiverr | search→checkout | S | Now / D1 |
| 6 | Provider trust panel (checklist with dates, member since, years, next start) | IndiaMART, Alibaba | search→checkout | S | Now |
| 7 | RFQ form v2: one free-text box, required marks, a live meter, suggested documents, budget chips | IndiaMART, Alibaba | RFQ→quote | S–M | Now |
| 8 | Package page v2: refund line, government disclaimer, "₹X + GST = ₹Y" | Vakilsearch, Moglix | search→checkout, dispute | S | Now |
| 9 | Task-first buyer home + provider "needs your action" + provider funnel | Fiverr, JustDial | repeat, RFQ→quote | M | Now |
| 10 | Order workspace: next-step bar, tabs, masked messaging (U7), "payment secured" | Upwork, Fiverr | dispute, review | M | Now |
| 11 | Provider onboarding v2: GSTIN auto-fill of 4 fields, step analytics, "what you'll need" | IndiaMART, GeM | providers onboarded | S–M | Now (PAN path: D3 + ADR) |
| 12 | Provider inbox filters/sort + buyer-verified badge | IndiaMART | RFQ→quote | S | Now / D2 |
| 13 | Package tiers + comparison matrix + "choose this if" | Vakilsearch, Fiverr | search→checkout | M | Schema |
| 14 | Priced add-ons; speed tiers in quotes | Fiverr, Xometry | take rate, RFQ→quote | M | ADR |
| 15 | Mobile provider parity: listings, orders, earnings, reviews; fix U8 | — | providers onboarded | M | Now |
| 16 | Voice search; te/ta for the buying path; provider content translation (provider approves) | IndiaMART | search→checkout | M | Now / agent (dark) |
| 17 | Consent notice for analytics if counsel requires it | Xometry (as the anti-pattern) | compliance | S | Counsel |

---

## 7. Open decisions this report adds

- **D-UX1: directed quote requests.** Should a buyer be able to request a quote from a specific provider (from that provider's page), alongside the category fan-out? It raises conversion from a profile, but changes matching and fairness; it needs a §8.1 proposal.
- **D-UX2: analytics consent.** Does DPDP require a consent notice before PostHog loads? Counsel question.
- **D1 (from the survey) drives items 5 and 6:** which measured stats buyers see.
