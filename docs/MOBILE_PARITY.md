# Mobile (Expo) parity debt

Design-system upgrades that landed on **web only** and needed a native
React Native / NativeWind equivalent in `apps/mobile`. The shared semantic
**color tokens** and the **type scale + radius** are mirrored in
`apps/mobile/tailwind.config.js` (hand-synced); JS-side colors (icon props,
shadows) live in `apps/mobile/lib/theme.ts`.

> Why a list: web and mobile do not share a token package — the two Tailwind
> configs are hand-synced. Anything that can't be expressed as a NativeWind
> utility (CSS-only features) diverges and must be tracked here.

**Status: ALL ITEMS CLOSED — Phase 8 §4, 2026-07-09.** New gaps get new
entries; keep closed items for the how.

---

## 1. Elevation + hover/press system — ✅ CLOSED (Phase 8 §4)

Closed by `components/ui/PressableCard.tsx` + `lib/theme.ts` shadow presets:
resting elevation ≈ web `shadow-resting` (Android `elevation`, iOS shadow
props), pressed state settles (lower shadow + scale 0.98 + opacity), scale
gated on `AccessibilityInfo.isReduceMotionEnabled` (parity with web
`motion-safe:`). Adopted by `ResultCard` (the main tappable card); use it for
any new tappable card/grid tile.

## 2. Form-control styling (`.field-select` chevron) — ✅ CLOSED (Phase 8 §4)

Closed by `components/ui/Select.tsx`: brand-styled trigger (h-11, border,
chevron — same affordance as web `.field-select`) opening a bottom-sheet
option list (plain `Modal`, no new native deps). First consumer: the state
filter on the search screen (`INDIAN_STATES` now exported from
`@amclub/shared` for both apps).

## 3. CMS hero banner — ✅ CLOSED (Phase 8 §4)

Closed by `components/HeroBanner.tsx`, mounted on the home screen: renders the
same `GET /api/v1/cms/banners?slot=hero` content as web (headline / subline /
CTA / discount, locale-resolved), discount chip only when > 0 (the
"discount must be backable" rule stays server-enforced), web CTA hrefs mapped
to mobile routes, decorative brand glow without a gradient dependency. A
failed fetch renders nothing — the hero is promotional, never blocking.

---

Also closed in the same pass (STATUS_AUDIT items):

- **M5 voice recorder**: hardcoded hex → `lib/theme.ts` tokens; recording now
  shows a pulsing ring (Animated loop, reduce-motion-aware) — spec parity
  with web's pulse.
- **H5 silent-`[]` API failures**: `searchCatalog` / `fetchMyOrders` /
  `fetchMyRfqs` / `fetchNotifications` return `ok`; search, category, orders,
  RFQ list and notifications screens render `components/ErrorState.tsx`
  (message + retry) instead of a fake empty state.
- **M1 hardcoded strings**: all four replaced earlier (common.not_found ×3,
  catalog.faqs); verified no raw literals remain.
- **CI**: `expo export` bundle check is now **blocking** in CI.

Still open (tracked in STATUS_AUDIT, not parity): no mobile gateway/first-run
wizard equivalent; te/ta locales are web-only by design (mobile ships en/hi).
