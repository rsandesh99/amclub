# AMClub — Pre-Launch Operations Checklist
**Owner:** Sandesh · **Rule:** an item is DONE only when its Evidence exists (screenshot, email, submitted-application ID, or a row in this file's log). Intent ≠ done.
**Commit this file as `docs/PRE_LAUNCH_CHECKLIST.md` and update statuses in git so history shows progress.**

Legend: ⏱ = your active time · 🕐 = external clock (someone else's approval) · Evidence = what proves it

---

## TRACK 0 — TODAY (≈45 min total). The verification blitz.

### 0.1 CRON_SECRET verified 🔴 (5 min)
1. Open `/admin` → Jobs panel. All five crons green?
2. If ANY red: Vercel → Settings → Environment Variables → check `CRON_SECRET` exists in **Production**. If missing: generate (`openssl rand -hex 32` or any 40+ random chars), add, redeploy, re-check panel.
**Evidence:** screenshot of all-green Jobs panel, dated.

### 0.2 Upstash rate limiting verified (5 min)
1. Same env page: `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` present in Production.
2. Live test: request OTP 6× rapidly from your phone → must get blocked/429 by attempt ~4.
**Evidence:** screenshot of the 429/too-many-requests message.

### 0.3 Spend caps — all vendors (20 min)
| Vendor | Where | Set |
|---|---|---|
| Vercel | Settings → Billing → Spend Management | $50 cap + alerts + pause-at-100% |
| Supabase | Org → Billing | spend cap ON / billing alerts |
| Razorpay | Dashboard alerts | note for live-mode day |
| OpenRouter | Credits page | prepaid only (no auto-top-up); note balance |
| Sarvam | Billing | note credits remaining; set reminder at 25% |
**Evidence:** one screenshot per dashboard in a `docs/evidence/` folder (or a private album). Yes, actually take them.

### 0.4 OTP real-device test (5 min)
Run `npx tsx scripts/check-otp-sms.ts` (with Vercel env) OR attempt phone-OTP login on production with your real number.
**Evidence:** SMS screenshot, or the script output saying SMS unconfigured (which is itself an answer → feeds Track 1.2).

### 0.5 Sarvam cost var (3 min)
`SARVAM_COST_PAISE_PER_MIN=50` in Vercel → redeploy → one voice RFQ → check `ai_invocations.cost_paise` non-null on the stt row.
**Evidence:** screenshot of the row.

---

## TRACK 1 — EXTERNAL APPROVALS. Start ALL FIVE this week; they run on other people's clocks (days→weeks). Order within the week doesn't matter; starting does.

### 1.1 Razorpay Live + Route 🕐 (⏱ ~1.5h to apply; approval 2–7 days typically)
1. Gather: Certificate of Incorporation, company PAN, GSTIN, cancelled cheque / bank statement of the Swathisri Infra Projects current account, director KYC (PAN+Aadhaar), business website URL (use amclub-web.vercel.app or the custom domain if 5.6 done — website must show the legal pages, which exist now).
2. Razorpay Dashboard → Account & Settings → complete **Activation form** (business category: services marketplace / SaaS-adjacent — answer honestly; they may ask follow-ups).
3. Separately raise a **Route activation** request (Dashboard → Route, or support ticket): explain the marketplace split-settlement use case (commission retained, provider paid out).
4. When approved: DO NOT flip keys yet — that's a gated go-live step (Track 5.5).
**Evidence:** activation-form submitted confirmation email/ID; Route request ticket number.

### 1.2 MSG91 + DLT 🕐 (⏱ ~2h; DLT approval 3–10 days)
1. msg91.com → business account with company details.
2. **DLT registration** (mandatory, telecom-regulator requirement): register Swathisri Infra Projects as Principal Entity on a DLT portal (Jio TrueConnect / Airtel / VI — MSG91's docs walk you through; needs CIN/PAN/GST + authorization letter). Fee ~₹5,900 typically.
3. Register **sender ID** (e.g., AMCLUB) and **templates**: OTP template ("Your AMClub login code is {#var#}") + the transactional order-event templates from `channels.ts`.
4. After approval: put `MSG91_AUTH_KEY` in Vercel AND configure MSG91 as the SMS provider in **Supabase → Auth → Providers → Phone** (this is the missing half from audit B4). Then tell the agent: "write the real MSG91 send in channels.ts:83 (the TODO), test with my number."
**Evidence:** DLT entity ID; template approval screenshots; one real SMS received.

### 1.3 WhatsApp Business API 🕐 (⏱ ~2h; Meta verification 1–3 weeks — the LONGEST pole, start first if you do them in any order)
1. Pick BSP: **Interakt** (easier self-serve) or Gupshup. Sign up with company details.
2. Meta Business verification: business docs into Meta Business Manager (the BSP guides this).
3. Dedicate a phone number NOT on personal WhatsApp.
4. Submit transactional templates (order placed/accepted/delivered, quote received — mirror the notification events).
5. On approval: `WHATSAPP_API_KEY` to Vercel; agent task: "implement the real WhatsApp send in channels.ts, template mapping per event."
**Evidence:** WABA ID; template approval status page; one real WhatsApp message received.

### 1.4 Surepass production KYC 🕐 (⏱ ~1h; approval days→2 weeks)
1. From sandbox account, request production access; submit company KYC docs.
2. On approval: swap `KYC_API_KEY` to production key; run one real GSTIN + one penny-drop against your own company details.
3. Agent task after: "re-verify the provider rows created under the KYC stub — flag any provider whose GSTIN/bank was stub-verified for re-verification before pilot."
**Evidence:** production key issued email; one real verification response in logs.

### 1.5 CA engagement — GST/TCS sign-off 🕐 (⏱ ~2h of meetings; opinion in ~1 week)
1. Find a CA with e-commerce/marketplace exposure (ask the Kurnool owner for a referral — CAs serving factories know marketplace GST).
2. Brief with these SPECIFIC questions (send DESIGN.md §9.1 + a sample buyer invoice + commission invoice PDF from test mode):
   a. Is the commission-invoice structure (SAC code, GST rate) correct?
   b. **TCS u/s 52 CGST**: confirm applicability, rate, and the collection+deposit workflow we must run; the `tcs_paise` column exists — what must populate it and when do we remit?
   c. TDS u/s 194-O applicability on provider payouts?
   d. Invoice-numbering/series compliance for the auto-generated PDFs.
3. Get it in WRITING (email opinion is fine).
**Evidence:** CA's written opinion; agent task afterward to implement whatever changes it dictates.

---

## TRACK 2 — LEGAL (this week, parallel; blocks pilot not code)

### 2.1 Counsel review of /terms, /privacy, /refund-policy (⏱ 1h to brief; ~1 week turnaround; ₹10–25k typical)
The pages exist and mirror real behavior — a lawyer's pass makes them defensible. Brief them on: marketplace-intermediary status, escrow flow, DPDP (voice consent + 30-day retention + purge), refund matrix.
**Evidence:** redlined doc back; agent applies edits.

### 2.2 Grievance officer page (⏱ 30 min)
IT Rules 2021 requires a named grievance officer + contact + SLA (24h ack / 15 day resolution). That's you for now. Agent task: "/legal/grievance page, footer-linked, en+hi."
**Evidence:** live page URL.

---

## TRACK 3 — QA CYCLE (post job TODAY; engagement next week)

### 3.1 Post the Upwork job (⏱ 30 min) — the drafted post is ready; paste it. Budget ₹15–20k, accept up to ₹25k for a strong native-Telugu tester.
**Evidence:** live job URL.
### 3.2 Prepare the handover pack (⏱ 45 min): STATUS_AUDIT.md's known-issues (so they don't re-report), test accounts (MSME + provider + admin view-only), Razorpay test cards, the "confidently-wrong voice pre-fill" as an explicit regression class, string files for the language review.
**Evidence:** a shared folder/doc link.
### 3.3 Screen applicants against the 4 questions; hire; kick off with a 30-min call walking the journeys.
### 3.4 Triage findings: Blockers → agent immediately; High → before pilot; Med/Low → logged.
**Evidence:** the severity sheet; fix commits referencing it.

---

## TRACK 4 — PRODUCT DECISIONS YOU OWE (30 min of thinking, then one message to the agent)

### 4.1 te/ta scope — DECIDE: recommend "translate MSME core path (catalog/RFQ/orders/auth); provider+admin stay English"; then native-review pass (the Kurnoul owner for te; find one ta reader).
### 4.2 Refund in-progress % — the constant in `packages/shared/src/money.ts` still sits at the agent's 50% default. Recommend 25–30%. Decide, tell agent, done.
### 4.3 Demo/seed providers on pilot day — keep Kapoor/Sharma/Rajesh visible, badge them "demo", or purge? Decide before first real MSME invite.
### 4.4 Custom domain — buy amclub.in (or chosen) NOW if doing it, BEFORE Razorpay live activation (the activation form asks for the website; changing domain later means updating webhook URL, OAuth redirect, Turnstile hostnames, Supabase Site URL — one coordinated agent task).
**Evidence for all four:** the decisions written into DESIGN.md changelog by the agent.

---

## TRACK 5 — REMAINING ENGINEERING (agent work; schedule AROUND the tracks above, not instead of)

5.1 Phase 8 proper: full-app axe pass; k6 load test (500 concurrent search / 50 checkout); backup: Supabase Pro + PITR ON + one rehearsed restore; OWASP checklist sign-off.
5.2 Mobile: real-device voice test (AAC path — YOU, 5 min); parity debt from MOBILE_PARITY.md; expo lint zero.
5.3 Golden set: per-category utterances incl. the Hyderabad recruitment regression; wire eval to CI.
5.4 te/ta implementation per 4.1 decision + native review fixes.
5.5 **GO-LIVE GATE (only after 1.1 approved + 1.5 opinion + 2.1 done + QA Blockers fixed):** flip Razorpay live keys, register live webhook, re-run replay/dropped kill-tests against LIVE test, one ₹1 real transaction end-to-end incl. refund. Evidence: the ₹1 order's full lifecycle screenshots.

---

## TRACK 6 — PROVIDER RECRUITMENT (starts NOW, runs continuously; the actual product)

### 6.1 Define the pilot cluster (⏱ 1h thinking)
Recommend: **Hyderabad (Balanagar/Jeedimetla industrial belt) + Kurnool** as the anchor geographies. Target liquidity: for each of the 4 launch-critical categories (Tax, Company & Reg, Gov & Licensing, HR) × Telangana/AP, at least 5 active providers → the /admin liquidity matrix is your scoreboard.
### 6.2 Materials (⏱ half a day, agent can draft):
- One-page provider pitch (PDF, en+te): "qualified leads, pay only on success, T+2 payouts, zero listing fee" + QR to /partner/signup.
- 3-message WhatsApp outreach sequence.
- 90-second demo script (voice RFQ → quote arrives) you can do on your phone in their office.
### 6.3 Channels, in order of conversion likelihood:
1. **The Kurnool owner's own CA, lawyer, and consultant contacts** — warm intros beat everything; ask him this week.
2. Local CA firms (ICAI Hyderabad chapter directory), labour consultants around industrial estates, DSAs.
3. MSME associations (FTCCI, AP & TS small industries associations) — one presentation gets you a room of both providers AND future buyers.
### 6.4 Cadence: 5 provider conversations/week minimum once QA-fixed build is stable. Track in a simple sheet: name, category, state, status (pitched/signed-up/KYC/active), source.
**Evidence:** the sheet, updated weekly; the liquidity matrix trending up.

### 6.5 MSME demand side (AFTER ≥20 active providers): the same associations, the Kurnool owner's peer network, and 6.2's materials flipped to the buyer story. Do NOT invite buyers into an empty store.

---

## SEQUENCING SUMMARY
- **Today:** Track 0 (45 min) + post QA job (3.1) + buy domain if doing (4.4).
- **This week:** all five Track-1 applications submitted + counsel briefed (2.1) + four decisions made (Track 4) + Kurnool-owner referral ask (6.3.1).
- **Next 2 weeks:** QA engagement runs; agent burns Track 5; approvals land one by one; provider conversations start.
- **Gate to pilot:** Track 5.5 gate + ≥20 active providers in the anchor cluster + QA Blockers zero.

*Update this file's statuses in git. The commit history of this checklist IS the A-grade evidence.*
