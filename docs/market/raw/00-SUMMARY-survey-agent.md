# AMClub market survey — cross-portal summary (23 Sep 2026)

This merges 19 portals. Each portal file carries its CHECKPOINT tables and FINAL REPORT in your prompt's format; paste them into the Claude Code session so it can check every "AMClub status" (especially the **CHECK** rows) against the code.

## Files and coverage

| File | Portal(s) | Mode | Depth | Blocked by |
|---|---|---|---|---|
| survey-IM-indiamart.md | IndiaMART | logged in (buyer) | **Full**: 4 checkpoints, 45 rows | Inbox not opened (rule 5 + browser safety block); seller side = shell + help docs |
| survey-AB-alibaba.md | Alibaba.com | logged in (buyer) | Full: 24 rows | AI Mode query hit a slider **CAPTCHA** |
| survey-TI-tradeindia.md | TradeIndia | logged in (buyer) | Medium: 16 rows | — |
| survey-VS-vakilsearch.md | Vakilsearch / Zolvit | the site showed **Login**, so treated as logged out | Medium: 15 rows | Checkout is a lead form |
| survey-MG-moglix.md | Moglix | logged in (buyer) | Medium: 13 rows; cart → checkout, then emptied | — |
| survey-FV-fiverr.md | Fiverr | logged in (buyer) | Medium: 19 rows | **"Press & Hold" bot check**; the checkout tab is still open (see below) |
| survey-XM-xometry.md | Xometry | logged in (buyer) | Medium: 16 rows; your existing quote viewed read-only | Uploads prohibited |
| survey-16-MM-1688-msmemart.md | 1688, MSME Global Mart | public | Light: 13 + 8 rows | 1688 detail page **CAPTCHA** |
| survey-public-IF-TN-UW.md | IndiaFilings, Tata nexarc, Upwork | public pages via research agent | Medium | Some pages 403/404 (noted) |
| survey-public-UD-IB-OB-AZB.md | Udaan, Industrybuying, OfBusiness, Amazon Business | public pages via research agent | Medium | Some help pages blocked (noted) |
| survey-public-ZW-GEM-JD.md | Zetwerk, GeM, JustDial | public pages via research agent | Medium; **includes a GeM seller-onboarding checklist** | JustDial mostly 403 |

**Evidence note:** the three `survey-public-*` files were compiled by research agents reading public pages and help articles, not by walking the portal in your browser. Treat them as a notch less certain than the logged-in files.

## Top 10 to adopt (across all portals), ranked

| # | Feature | Seen at | Metric it moves | Effort | Principles | Main risk |
|---|---|---|---|---|---|---|
| 1 | **Live RFQ "strength" meter** with field weights and a "fill next" hint | IndiaMART (IM-18); Alibaba AI spec expansion (AB-04) | RFQ→quote ≥70% | S | ✅ | Score padding |
| 2 | **Measured outcome stats on provider profiles**: repeat-buyer %, on-time %, response rate. The AMC Score stays hidden | Alibaba (reorder %, on-time dispatch %), 1688 (回头率, fulfilment %), IndiaMART (response/call %), Fiverr (orders in queue) | search→checkout, 90-day repeat | S | ✅ | Small-n noise; show only above N orders |
| 3 | **Earned "Verified Business Buyer" signal shown to providers** (Udyam + GSTIN + paid-order history), free | IndiaMART sells it at ₹999/month–₹9,999/yr (IM-27/29) | RFQ→quote | S–M | ✅ | Disadvantages new buyers |
| 4 | **Paid add-ons on packages** (fast-track, extra revision, extra deliverable), each with ₹ and +days | Fiverr (FV-07) | take rate, search→checkout | M | ✅ (no negotiation) | Price creep; cap the count |
| 5 | **Registration + 12-month compliance bundles** with milestone escrow payouts, and "Choose this if…" tier lines | Vakilsearch Elite (VS-01), IndiaFilings/LEDGERS | 90-day repeat ≥25% | M | ✅ | Long-duration escrow, provider churn |
| 6 | **"Needs advisor"**: business profile → the registrations/licences you likely need → routes to categories (no advice) | Unmet at Vakilsearch (its "AI search" is autocomplete, VS-07) | search→checkout | M | ✅ (routing only) | Must not read as legal advice |
| 7 | **Three speed tiers in one quote** (Economy / Standard / Express) | Xometry (XM-04), Moglix 24 h vs 5-day (MG-04) | RFQ→quote, search→checkout | M | ✅ (buyer picks) | Providers gaming the Express premium |
| 8 | **AMC Mart dual mode: "Buy now" and "Make to order"** on the same query, with ITC ₹ shown at checkout and ships-in-48 h / return-shipping-covered / fast-GST-invoice promises | 1688 (16-01/05), Moglix (MG-03), Industrybuying/Amazon Business ("save up to 18%") | search→checkout (goods) | M | ✅ | Promise breaches; tie them to the delivery-photo payout |
| 9 | **Tender / GeM alerts for govt-licensing providers** + an in-product **GeM onboarding checklist** | IndiaMART tenders tab, MSME Mart AOC/L-1 data, GeM checklist (agent file) | providers onboarded, RFQ→quote | S–M | ✅ (alerts only; no bidding in AMClub) | Tender data licensing; rules change, so date-stamp the checklist |
| 10 | **Reorder library / repeat part + one-tap reorder** | Xometry (XM-09), Industrybuying/Udaan (agent file), Fiverr repeat-client reviews | 90-day repeat ≥25% | S–M | ✅ | Stale prices at reorder |

**Runners-up:**
- Search relevance thumbs (IM-07).
- Failed search → inline RFQ (IM-08).
- AI review summary built only from verified-purchase reviews (FV-12).
- A buyer-visible verification checklist with dates (IM-25/26).
- A "Funded ✓" milestone badge for providers (Upwork).
- Stage-wise photo evidence at milestones (Zetwerk).
- Category-tiered return windows with a non-returnable list (Industrybuying/Udaan).
- Forward-to-purchaser approval (Xometry).

## Flagged conflicts with your principles (do NOT adopt as-is)
- **AI negotiation agents**: Alibaba AI Mode "send inquiry and negotiate", plus the "AI negotiate" button in the compare tray. NOT-NOW.
- **Reverse-auction RFQ marketplaces**: Alibaba's seller side, GeM bidding/RA. NOT-NOW.
- **"Request a discount from multiple suppliers"**: Amazon Business. The agent file proposes a "capped single-round discount request". That is **per-buyer negotiation** and conflicts with NOT-NOW; I've left it in its file for completeness.
- **Pre-order provider chat**: Fiverr "Contact me", TradeIndia "View Number", IndiaMART "Call Now". This is exactly what our no-chat-before-RFQ rule prevents.
- **Paid rank labels that look like quality badges**: IndiaMART STAR/LEADING, TrustSEAL bundled into a ₹60k/yr ad plan.

## AI horizon — consolidated (build the foundations now)

**1. CAD → price band for Kurnool job-shop work** (Xometry-style guidance, not platform pricing).
- **Log now:** extracted geometry features, the typed spec, all quotes, the winner, and the paid amount per CAD RFQ.
- **Dark version:** shadow price band, error tracked, shown to nobody.

**2. Provider-fit % and a reasoned shortlist before any RFQ** (IndiaMART Procurement Assistant "% match", Alibaba AI Compare).
- **Log now:** the buyer's typed constraints per RFQ, a quote-loss reason label, shortlist events, compare-flag views.
- **Dark version:** rule-based fit % logged, not shown.

**3. Business profile → obligations engine** (LATER: compliance calendar).
- **Log now:** a "licences held" table (type, number, issue date, expiry, authority, certificate), and AP/Telangana rule tables with sources.
- **Eval:** 50 profiles checked by a CA.

**4. Credibility cross-checks against outside records** (Alibaba vets suppliers against customs records).
- **Log now:** timestamped verification evidence per provider, plus the declared main category versus the categories of paid orders.
- **Dark version:** nightly GSTIN-status re-check.

**5. Indic voice search and voice RFQ in 9+ languages** (IndiaMART already does voice search in 9 languages).
- **Log now:** consented audio→text→edited-text triples, and a service-term synonym table (Hindi/Telugu → category).

**6. Photo/drawing → typed goods RFQ with HSN** (IndiaMART photo RFQ, 1688 image search).
- **Log now:** image → final-RFQ pairs, per-field correction logs, an HSN-from-image eval set.

## Anti-patterns seen (avoid)
- **Spam calls sold back to buyers.** IndiaMART's help article advises deleting your requirement or deactivating your account; "No spam calls" is a paid VBB Max feature.
- **Fake urgency.** Every TradeIndia package has a countdown; Vakilsearch shows perpetual "50–75% off"; Alibaba runs "Super September".
- **Drip fees.** Moglix ₹19 platform fee and Fiverr ~7.4% service fee appear only at checkout.
- **Pre-ticked consent.** Alibaba "share my business card" on RFQ; WhatsApp opt-in pre-toggled on Vakilsearch.
- **"AI" labels that aren't earned.** Vakilsearch keyword autocomplete; TradeIndia AI search takes ~30 s and ignores MOQ vs quantity.
- **Narrow "protection".** IndiaMART covers non-delivery only, NEFT-to-verified-account only, with a 15–60 day claim.

## What only you can decide
1. **A public earned tier from AMC Score bands** (e.g. "Reliable"), with no number shown. This changes the "buyers never see the score" rule.
2. **For AMC Mart custom processing:** stay provider-priced, or take a Xometry-style platform price for simple job-shop work?
3. **A free earned Verified Business Buyer badge.** It favours established MSMEs.
4. **Micro-unit scheme subsidies.** Can our fees be claimed under MSME schemes (as MSME Mart's 75% PMS subsidy is)?

## Housekeeping
- **Fiverr checkout tab:** a "Secure Checkout" tab is still open in your browser, and it wouldn't close from my side (it likely shows a "Leave site?" prompt). **Please close it.** No card was entered and nothing was charged.
- **Moglix cart:** confirmed empty.
- **Alibaba compare tray:** cleared.
- **Nothing sent or submitted:** no enquiries, RFQs or forms on any portal.
- **Your own GitHub tab:** untouched.
