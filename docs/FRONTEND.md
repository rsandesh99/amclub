# AMC — FRONTEND.md (v2 — Emerald & Gold direction)
UI/UX design system + rebuild guidance for the AMC services app and the Mart mode.
Companion to DESIGN.md and RULES.md. Audience: Claude Code + the developer.
Founder-set direction (binding): green + gold identity, flashy custom animations, inventive
backgrounds, beautiful cards/layouts/shadows, high-contrast readable type. This document makes
that direction excellent: every flourish is crafted, purposeful, and fast on budget Androids.

## 1. WHO THIS IS FOR (unchanged brief — every choice still traces to this)
Hyderabad industrial cluster first: small CNC shops, job-work units, niche parts makers, and
the MSMEs buying from them. Budget/mid Android; shop-floor sunlight, noise, gloved fingers,
30-second sessions; Telugu-first speech with English technical vocabulary; WhatsApp + PhonePe
are the learned UI language; money-anxious, trust-scanning users; the ENGINEERING DRAWING is
the atom of CNC business (RFQs carry drawings — the drawing is the hero object).
Flashy serves trust here, not fashion: the app should feel like a PROSPEROUS, PRECISE
institution — festival-grade gold on disciplined emerald — never like a casino.

## 2. DESIGN IDENTITY — "EMERALD & BRASS"
Concept: prosperity + precision. Deep emerald authority (banks, currency, growth) with
metallic gold moments (celebration, verification, money). Gold is EARNED on screen: it marks
verified things, money events, and wins — never wallpaper. One lavish element per screen;
everything around it disciplined.
### 2.1 Color tokens
- emerald-ink   #0A2E22  — primary text on light, deep authority surfaces
- emerald       #0E6B4F  — primary actions, active states, brand core
- emerald-deep  #072B1F→#0E6B4F — hero/celebration background gradient range
- ivory         #FCFAF3  — main background (warm paper, sunlight-friendly)
- gold          #C9A227  — the metal. Base of the gold system, never used flat:
  gold-bright #EDD27A / gold-deep #8C6D14 as gradient stops for metallic renders
- brass-line    #B08D2A  — hairlines, borders, dividers on ivory (gold's quiet voice)
- ink           #14161A  — numerals and dense data (tabular money)
- stamp-red     #A63A2B  — errors/disputes only (never decorative)
Contrast law (the founder's "readable" is enforced): body text is ALWAYS emerald-ink or ink on
ivory (≥7:1). GOLD NEVER RENDERS SMALL TEXT — gold appears only as: ≥20px bold display numerals,
icons, borders/hairlines, fills behind dark text, and metallic gradient elements. Gold-on-ivory
small text is a review-blocking violation.
### 2.2 Backgrounds (inventive, but layered and quiet under content)
- Default surfaces: ivory, clean.
- Signature background: the JAALI-BLUEPRINT lattice — a custom SVG pattern fusing Deccani jaali
  geometry with engineering dimension-lines, rendered in brass-line at 4–6% opacity on ivory
  (8–10% on emerald-deep). Appears on: home headers, empty states, success screens, pool cards.
  Never behind dense text or tables.
- Hero/celebration surfaces: emerald-deep vertical gradient + jaali lattice + a single soft
  gold light-bloom (radial, static). Payment success, score reveals, onboarding welcome.
- Never: stock photos as backgrounds, busy gradients under body text, animated backgrounds on
  list screens.
### 2.3 Cards & shadows (beautiful, systematic)
- Sheet card (default): ivory, 10px radius, 1px brass-line top hairline, two-layer shadow
  (0 1px 2px rgba(10,46,34,.06) + 0 8px 24px rgba(10,46,34,.10)) — soft depth, no grey mud.
- Gold-edge card (earned): verified providers, accepted quotes, won pools — adds a 2px metallic
  gradient left edge + a one-time shimmer sweep on entrance.
- Emerald card (money): payout/earnings summary — emerald surface, ivory text, gold numerals
  ≥24px. The richest card in the system; one per screen maximum.
- Elevation has exactly 3 levels (flat list row / sheet / modal). No random shadows.
### 2.4 Type
- Noto Sans + Noto Sans Telugu + Noto Sans Devanagari (cross-script harmony beats a Latin-only
  display face). Hierarchy by size/weight: body 17/26 mobile, titles 22–28 bold, money display
  30–36 semibold TABULAR numerals. Sentence case; no all-caps labels; line length <80ch.
- Display flourish allowed: page-title treatment may letter-space slightly and sit on the jaali
  header — the type itself stays Noto for script harmony.

## 3. MOTION SYSTEM — "GOLDSMITH MOTION" (custom, signature, fast)
Rules of the metal: every animation answers an action or celebrates a milestone; one orchestrated
entrance per page (never per-card scatter); transform/opacity only (60fps on budget Android);
standard moves 180–320ms, celebrations ≤1400ms; Lottie/hand-built canvas ONLY for the four hero
animations below; prefers-reduced-motion gets instant-state fallbacks everywhere; nothing loops
ambiently on content screens.
### 3.1 Signature set (build once as packages/shared motion primitives, reuse everywhere)
1. GOLD STAMP — confirmations (quote accept, buyer confirm, admin release): a gold seal presses
   in with a 6px paper-indent scale bounce, metallic gradient sweep across the seal once,
   subtle haptic. THE brand gesture.
2. PAISA MOMENT — payment success & payout released: full-screen emerald-deep, a gold coin
   flips down and lands as a tick, radial shimmer bloom, amount counts up in gold tabular
   numerals, jaali lattice breathes +2% opacity once. ≤1.4s, skippable by tap.
3. GOLD THREAD TIMELINE — order/milestone tracker: completed steps connected by a drawn gold
   thread; each new milestone draws the next segment (400ms) and stamps the node.
4. MOLTEN FILL — pool progress and score bars: liquid-gold fill with a moving specular
   highlight; fills on scroll-into-view once, then static.
5. Shimmer sweep — single 700ms diagonal sheen on gold-edge cards and gold numerals at
   entrance only.
6. Count-up numerals — all money and score numbers animate 300–600ms on first paint.
7. LATHE SPINNER — loading/pull-to-refresh: a machined emerald ring with a gold cutting-point
   orbiting; skeletons shimmer ivory→gold-tint.
8. VOICE RING — record button: emerald waveform ring pulsing with gold amplitude peaks; live
   transcription types in beneath (visual confirmation against machine noise).
9. Sheet & stamp micro-moves — modals rise 240ms with slight overshoot; chips "press"; toggles
   land with a 2-frame gold glint.
10. Page entrance — ONE orchestrated sequence: header settles, title block slides 12px up,
   content fades in staggered 40ms — total ≤500ms, first paint never blocked.
### 3.2 Where flash is forbidden
Dense tables, admin screens (Linear-fast, motion-minimal), error states (calm, instructive),
anything mid-payment before result (no motion while money is uncertain).

## 4. PATTERN REFERENCES (what to take, updated for this direction)
- CRED — the proof that lavish, celebration-rich UI builds trust in Indian money apps: take the
  reward-moment choreography, the restraint AROUND the lavish element, the haptic pairing.
- PhonePe/GPay — money-status timeline and the success-moment anatomy (ours goes gold).
- WhatsApp — thread layout for RFQ clarifications; forwardable pool cards with rich OG images
  (emerald card, gold progress, product photo) that look premium inside a group chat.
- Swiggy — live-order psychology for milestones ("Delivery photo expected by Thu").
- Zerodha — numbers-first restraint for the earnings LEDGER (the emerald card celebrates; the
  table below it is pure Zerodha).
- Xometry — part-centric quoting: drawing thumbnail is the RFQ's face everywhere.
- Faire — per-unit + per-order pricing clarity; "you'll receive ₹X by [date]" certainty.
- IndiaMART — the anti-pattern: clutter, popups, fake urgency. Our lavishness is craft, never noise.

## 5. GLOBAL QOL STANDARDS (unchanged and binding)
48dp touch targets; sticky primary action in thumb zone; one primary action per screen.
Skeletons not spinners; pull-to-refresh; instructive empty states; errors say what happened and
what to do. Offline photo/voice queues with visible retry states — never lose a capture.
Camera-first evidence flow (shared component). Per-field confirm UIs for AI extractions
(ai_decisions hooks). Money surfaces always show amount + status + next event date; the fee
story on earnings ("You receive your full amount minus only AMC's 5%. Gateway charges are on
us."). Persistent one-tap language switch (en/hi/te). Perf: p75 LCP <2.5s on mid Android/4G;
animations never delay interactivity; Lottie assets ≤120KB each, lazy-loaded. Accessibility
floor: visible focus, reduced-motion respected, 7:1 body contrast, labeled inputs.

## 6. PAGE-BY-PAGE REDESIGN PRIORITY (services; each = one gated phase)
P1 RFQ create — voice-first hero on emerald header (voice ring), drawing upload as part-card
   with thumbnail, per-field confirm screen. The front door gets the identity first.
P2 Order detail — title block + GOLD THREAD timeline with photo thumbnails + money line.
   The trust screen; Paisa Moment fires here on release/confirm events.
P3 Quote compare — sheet rows, gold-edge on accepted, tabular money, the four commercial-term
   chips, "Not stated — ask before deciding" hints; accept = Gold Stamp.
P4 Earnings/payouts — one emerald money card up top (count-up), Zerodha ledger below, UTR on
   paid rows, readiness banner pattern on top.
P5 Provider home — today's work cards: matched RFQs with response-window countdown chips
   (amber → stamp-red as expiry nears), photo-due orders; one action per card.
P6 Clarification thread — WhatsApp bubbles (when feature ships).
P7 Private score page — "your track record": Molten-fill factor bars, movement hints, no
   gamification glitter beyond the fills.
P8 Buyer home + search — jaali header, category tiles with engraved line icons, hybrid search.
Empty/error/offline states ship WITH each page.

## 7. MART SURFACES (behind MART_ENABLED; inherit all above)
Product page: sheet card + price-tier dimension table + ITC line + sticky Add. Pool card: the
flagship WhatsApp artifact — emerald card, product photo, Molten-fill progress, "₹X blocked in
YOUR account; taken only if the group fills, else auto-released" in plain type, one gold Join.
Pool met = Paisa-Moment variant (group celebration). Goods order timeline = same Gold Thread,
parameterized by orders.kind. Catalog manager = photos + voice → per-field confirms → "sent
for approval" stamp.

## 8. COMPATIBILITY vs DESIGN.md
Aligned: kind-parameterized shared components; server-computed money only (frontend NEVER
computes totals/fees/ITC — display server values; client money arithmetic is review-blocking);
camera component shared across milestone/delivery/dispatch; MART_ENABLED gates nav/routes/deep
links with inertness killtests; per-field confirm surfaces feed ai_decisions.
STANDING GAP (carry until closed): add 'te' locale — packages/shared i18n, Noto Sans Telugu in
the font stack, 'te' added to every render assertion (en/hi/te). P1-adjacent; Sarvam already
speaks Telugu, the UI must match.

## 9. PROCESS (per RULES.md gates, with motion review added)
Per page phase: (1) plan + ASCII wireframe + WHICH signature animations fire where, reviewed
against §2–§3 — generic SaaS output means revise before code; (2) build from tokens/primitives
only (no ad-hoc hex, shadows, or one-off animations — extend the system via this doc);
(3) screenshot review at 360×800@3x incl. a low-brightness sanity pass; (4) motion review on a
mid-range Android profile (60fps or the animation is cut/simplified — craft means smooth, jank
is the opposite of premium); (5) suites green incl. en/hi/te visible-markup assertions;
(6) founder eyeballs preview before push. One lavish element per screen; when in doubt, polish
the gold you have instead of adding more.
