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
        // §4.2 semantic design tokens — named by JOB. Values live in
        // app/globals.css as channels (`--c-*`); [data-ui="v3"] re-points them
        // for Experience v3 "Precision", so no component changes per theme.
        // Never use raw gray-*/amber-* or hex in components.
        primary: {
          DEFAULT: 'rgb(var(--c-primary) / <alpha-value>)',
          strong: 'rgb(var(--c-primary-strong) / <alpha-value>)',
          foreground: 'rgb(var(--c-primary-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)', // marigold — discounts + rating stars ONLY
          foreground: 'rgb(var(--c-accent-foreground) / <alpha-value>)',
        },
        // Pre-mixed soft-tint fills for badges / icon chips / section washes.
        'primary-soft': 'rgb(var(--c-primary-soft) / <alpha-value>)',
        'accent-soft': 'rgb(var(--c-accent-soft) / <alpha-value>)',
        'verified-soft': 'rgb(var(--c-verified-soft) / <alpha-value>)',
        'success-soft': 'rgb(var(--c-success-soft) / <alpha-value>)',
        'warning-soft': 'rgb(var(--c-warning-soft) / <alpha-value>)',
        'danger-soft': 'rgb(var(--c-danger-soft) / <alpha-value>)',
        success: 'rgb(var(--c-success) / <alpha-value>)',
        // Verification blue — badges/ticks ONLY (`trust` is the legacy alias).
        trust: 'rgb(var(--c-trust) / <alpha-value>)',
        verified: 'rgb(var(--c-verified) / <alpha-value>)',
        // Destructive/hard-error red — never decorative (`danger` alias kept).
        danger: {
          DEFAULT: 'rgb(var(--c-danger) / <alpha-value>)',
          foreground: 'rgb(var(--c-danger-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'rgb(var(--c-destructive) / <alpha-value>)',
          foreground: 'rgb(var(--c-danger-foreground) / <alpha-value>)',
        },
        // Caution/pending (under-review, external waits). Distinct from accent.
        warning: {
          DEFAULT: 'rgb(var(--c-warning) / <alpha-value>)',
          foreground: 'rgb(var(--c-warning-foreground) / <alpha-value>)',
        },
        background: 'rgb(var(--c-background) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        // v3 `bg/sunken`: inputs, table header rows, segmented-control track.
        sunken: 'rgb(var(--c-sunken) / <alpha-value>)',
        border: 'rgb(var(--c-border) / <alpha-value>)',
        muted: 'rgb(var(--c-muted) / <alpha-value>)',
        // v3 hairlines (brass at 35 %); v2 falls back to the border colour.
        separator: {
          DEFAULT: 'var(--separator)',
          strong: 'var(--separator-strong)',
        },
        foreground: {
          DEFAULT: 'rgb(var(--c-foreground) / <alpha-value>)',
          // ≥7:1 body floor (FRONTEND.md §5/§8) in both themes.
          secondary: 'rgb(var(--c-foreground-secondary) / <alpha-value>)',
          // Captions/placeholders only — never money (≥4.5:1).
          tertiary: 'rgb(var(--c-foreground-tertiary) / <alpha-value>)',
        },
        // All money and stats (tabular).
        numeric: 'rgb(var(--c-numeric) / <alpha-value>)',
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
        // heading hierarchy (Indic locales reset tracking/leading in
        // globals.css). `sm` and `base` were both 15px; base is now 16/1.6,
        // sm 15/1.55 — a conservative step toward the 17/26 body target.
        xs: ['13px', { lineHeight: '1.4' }],
        sm: ['15px', { lineHeight: '1.55' }],
        base: ['16px', { lineHeight: '1.6' }],
        md: ['17px', { lineHeight: '1.4' }],
        lg: ['20px', { lineHeight: '1.3', letterSpacing: '-0.01em' }],
        xl: ['24px', { lineHeight: '1.25', letterSpacing: '-0.015em' }],
        '2xl': ['30px', { lineHeight: '1.2', letterSpacing: '-0.02em' }],
        '3xl': ['36px', { lineHeight: '1.15', letterSpacing: '-0.022em' }],
        '4xl': ['44px', { lineHeight: '1.08', letterSpacing: '-0.025em' }],
        '5xl': ['56px', { lineHeight: '1.04', letterSpacing: '-0.028em' }],
      },
      borderRadius: {
        card: 'var(--radius-card)',
        button: 'var(--radius-button)',
        input: 'var(--radius-input)',
        chip: 'var(--radius-chip)',
        sheet: 'var(--radius-sheet)',
        modal: 'var(--radius-modal)',
      },
      // §4 elevation scale — ONE coherent system. Brand-tinted (cool green-black)
      // so shadows harmonise with the #1B4D3E palette instead of flat grey.
      // resting → hover → lg map to the card lift states; `card` is kept as an
      // alias for the many existing `shadow-card` usages.
      boxShadow: {
        // Values in globals.css (`--shadow-*`); v3 renders them at 70 %.
        xs: 'var(--shadow-xs)',
        resting: 'var(--shadow-resting)',
        card: 'var(--shadow-resting)',
        hover: 'var(--shadow-hover)',
        lg: 'var(--shadow-lg)',
        pressed: 'inset 0 1px 2px 0 rgb(16 30 24 / 0.10)',
        sheet: 'var(--shadow-sheet)',
        modal: 'var(--shadow-modal)',
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
