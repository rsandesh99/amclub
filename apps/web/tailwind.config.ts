import type { Config } from 'tailwindcss'
import animate from 'tailwindcss-animate'

const config: Config = {
  darkMode: ['class'],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // §4.2 semantic design tokens — named by JOB. The palette is locked;
        // never use raw gray-*/amber-* or hex in components.
        primary: {
          DEFAULT: '#1B4D3E', // brand — FINAL, never blue/navy
          strong: '#143F33', // hover/pressed deepen
          foreground: '#FFFFFF',
        },
        accent: {
          DEFAULT: '#F4A300', // marigold — discounts + rating stars ONLY
          foreground: '#1A1D1A',
        },
        // Pre-mixed soft-tint fills for badges / icon chips / section washes.
        'primary-soft': '#E8EEEB',
        'accent-soft': '#FDEFD2',
        'verified-soft': '#E6EFF8',
        'success-soft': '#E5F2EC',
        'warning-soft': '#F5EBDD',
        'danger-soft': '#F8E8E8',
        success: '#14724A', // positive/completed (green family) — ≥4.5:1 on success-soft
        // Verification blue — badges/ticks ONLY. `verified` is the semantic name;
        // `trust` kept as an alias for existing usages. ≥4.5:1 on verified-soft.
        trust: '#155C9E',
        verified: '#155C9E',
        // Destructive/hard-error red — never decorative. `destructive` is the
        // semantic name; `danger` kept as an alias.
        danger: {
          DEFAULT: '#C73E3E',
          foreground: '#FFFFFF',
        },
        destructive: {
          DEFAULT: '#C73E3E',
          foreground: '#FFFFFF',
        },
        // Caution/pending (under-review, external waits). Distinct from accent.
        warning: {
          DEFAULT: '#92400E', // ≥4.5:1 on warning-soft and /10 tints (a11y AA)
          foreground: '#FFFFFF',
        },
        background: '#FAFAF7',
        surface: '#FFFFFF',
        // De-emphasis: borders + muted surfaces (replaces raw gray-*).
        border: '#E6E7E3',
        muted: '#F3F4F1',
        foreground: {
          DEFAULT: '#1A1D1A',
          secondary: '#5C645C', // muted text + disabled
        },
        // ── AMC Mart / FRONTEND.md v2 "Emerald & Brass" tokens (§2.1) ───────
        // ADDITIVE: the services palette above is untouched; these are used by
        // Mart surfaces (behind MART_ENABLED) and by services pages only as
        // each P1–P8 redesign phase lands. Contrast law: gold NEVER renders
        // small text — ≥20px bold numerals, icons, hairlines, fills, gradients.
        emerald: {
          DEFAULT: '#0E6B4F', // primary actions, active states, brand core
          ink: '#0A2E22', // body text on ivory (≥7:1), deep authority surfaces
          deep: '#072B1F', // hero/celebration gradient start
        },
        ivory: '#FCFAF3', // warm paper background, sunlight-friendly
        gold: {
          DEFAULT: '#C9A227', // the metal — never flat; gradient stops below
          bright: '#EDD27A',
          deep: '#8C6D14',
        },
        brass: '#B08D2A', // hairlines, borders, dividers on ivory
        ink: '#14161A', // numerals + dense data (tabular money)
        stamp: '#A63A2B', // errors/disputes only — never decorative
      },
      fontFamily: {
        // --font-indic is set per-locale in app/[locale]/layout.tsx (Noto Sans
        // Devanagari / Telugu / Tamil); unset for en, hence the fallback value.
        // FRONTEND.md v2 §2.4 — ONE face across scripts: Noto Sans (Latin) with
        // the locale's Noto Indic companion. Display hierarchy comes from
        // size/weight, not a second family — one fewer font download on 4G.
        display: ['var(--font-rupee)', 'var(--font-sans)', 'var(--font-indic, sans-serif)', 'sans-serif'],
        // 'Noto Sans Devanagari' is NOT listed as a literal fallback: that is the
        // web-font family name, and naming it here made English pages download
        // its 120 KB Devanagari file. system-ui carries the device's own scripts.
        sans: ['var(--font-rupee)', 'var(--font-sans)', 'var(--font-indic, sans-serif)', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        // FRONTEND.md §2.4 — mobile body 17/26, secondary 15/22 (sunlight + gloves).
        body: ['17px', { lineHeight: '26px' }],
        meta: ['15px', { lineHeight: '22px' }],
        // §4.2 type scale — tightened tracking on the larger steps for cleaner
        // heading hierarchy. Body stays at 15px.
        xs: ['13px', { lineHeight: '1.4' }],
        sm: ['15px', { lineHeight: '1.5' }],
        base: ['15px', { lineHeight: '1.5' }],
        md: ['17px', { lineHeight: '1.4' }],
        lg: ['20px', { lineHeight: '1.3', letterSpacing: '-0.01em' }],
        xl: ['24px', { lineHeight: '1.25', letterSpacing: '-0.015em' }],
        '2xl': ['30px', { lineHeight: '1.2', letterSpacing: '-0.02em' }],
        '3xl': ['36px', { lineHeight: '1.15', letterSpacing: '-0.022em' }],
        '4xl': ['44px', { lineHeight: '1.08', letterSpacing: '-0.025em' }],
        '5xl': ['56px', { lineHeight: '1.04', letterSpacing: '-0.028em' }],
      },
      borderRadius: {
        card: '12px',
        button: '10px',
        chip: '999px',
      },
      // §4 elevation scale — ONE coherent system. Brand-tinted (cool green-black)
      // so shadows harmonise with the #1B4D3E palette instead of flat grey.
      // resting → hover → lg map to the card lift states; `card` is kept as an
      // alias for the many existing `shadow-card` usages.
      boxShadow: {
        xs: '0 1px 2px 0 rgb(16 30 24 / 0.05)',
        resting: '0 1px 2px 0 rgb(16 30 24 / 0.04), 0 1px 3px 0 rgb(16 30 24 / 0.08)',
        card: '0 1px 2px 0 rgb(16 30 24 / 0.04), 0 1px 3px 0 rgb(16 30 24 / 0.08)',
        hover: '0 6px 16px -4px rgb(16 30 24 / 0.12), 0 2px 6px -2px rgb(16 30 24 / 0.07)',
        lg: '0 16px 40px -8px rgb(16 30 24 / 0.16), 0 4px 12px -4px rgb(16 30 24 / 0.08)',
        pressed: 'inset 0 1px 2px 0 rgb(16 30 24 / 0.10)',
        // FRONTEND.md §2.3 — sheet card two-layer shadow (soft depth, no grey mud)
        sheet: '0 1px 2px rgba(10,46,34,.06), 0 8px 24px rgba(10,46,34,.10)',
        modal: '0 2px 6px rgba(10,46,34,.08), 0 24px 64px rgba(10,46,34,.18)',
      },
      backgroundImage: {
        // Metallic gold — the ONLY way gold is rendered as a fill/edge.
        'gold-metal': 'linear-gradient(135deg, #8C6D14 0%, #C9A227 35%, #EDD27A 55%, #C9A227 75%, #8C6D14 100%)',
        'emerald-hero': 'linear-gradient(180deg, #072B1F 0%, #0E6B4F 100%)',
      },
      transitionDuration: {
        DEFAULT: '180ms',
      },
    },
  },
  plugins: [animate],
}

export default config
