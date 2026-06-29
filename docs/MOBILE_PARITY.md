# Mobile (Expo) parity debt

Design-system upgrades that landed on **web only** and still need a native
React Native / NativeWind equivalent in `apps/mobile`. The shared semantic
**color tokens** and the **type scale + radius** are already mirrored in
`apps/mobile/tailwind.config.js`; the items below are the gaps.

> Why a list: web and mobile do not share a token package — the two Tailwind
> configs are hand-synced. Anything that can't be expressed as a NativeWind
> utility (CSS-only features) diverges and must be tracked here.

---

## 1. Elevation + hover/press system  (added 2026-06-29)

**Web has, mobile lacks.** The web elevation scale
(`shadow-resting / shadow-hover / shadow-lg / shadow-pressed` in
`apps/web/tailwind.config.ts`) and the interactive surface behaviour
(`.card-interactive`, `.chip-toggle`, button hover/active states in
`apps/web/app/globals.css`) are **CSS-only and web-only**:

- React Native has **no CSS `box-shadow`** — elevation is per-component via
  `style={{ elevation }}` (Android) + `shadowColor/shadowOffset/shadowOpacity/
  shadowRadius` (iOS).
- React Native has **no `:hover` / `:active` / `:focus-visible`** — feedback is
  via `Pressable`'s `pressed` state (and `onFocus` for external keyboards), not
  CSS pseudo-classes. Touch UIs press, they don't hover.
- `prefers-reduced-motion` → use RN's `AccessibilityInfo.isReduceMotionEnabled`
  / `useReducedMotion()` to gate any lift/scale animation.

**To close:** add an RN shadow preset (a `cardShadow` style object, or a
`<Card>` / `<PressableCard>` component) approximating `shadow-resting` at rest
and a slightly deeper shadow + subtle scale on `pressed`, reduced-motion-aware.
Equivalent press feedback for buttons, chips, and tappable list/grid cards.

## 2. Form-control styling (`.field-select` chevron)  (added 2026-06-29)

The web `.field-select` replaces the native `<select>` arrow with a
token-coloured SVG chevron (CSS `appearance: none` + background-image). On
mobile there is no `<select>`; pickers are native (`@react-native-picker` or a
bottom-sheet). Parity = a styled picker/select component matching the brand
(consistent height, border, focus, chevron affordance) rather than the raw OS
picker.

## 3. CMS hero banner  (added 2026-06-29)

`HeroBanner` (web, `components/cms/HeroBanner.tsx`) renders the CMS `hero` slot
with the styled gradient/elevation treatment. Mobile consumes the same
`GET /api/v1/cms/banners?slot=hero` data but has **no native hero component
yet** — it should render the editable headline/subline/CTA/discount with an
RN-native layout (and the same "discount must be backable" honesty rule already
enforced server-side).
