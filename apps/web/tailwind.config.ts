import type { Config } from 'tailwindcss'

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
          foreground: '#FFFFFF',
        },
        accent: {
          DEFAULT: '#F4A300', // marigold — discounts + rating stars ONLY
          foreground: '#1A1D1A',
        },
        success: '#1E8E5A', // positive/completed (green family)
        // Verification blue — badges/ticks ONLY. `verified` is the semantic name;
        // `trust` kept as an alias for existing usages.
        trust: '#1A6FBF',
        verified: '#1A6FBF',
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
          DEFAULT: '#B45309',
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
      },
      fontFamily: {
        display: ['var(--font-bricolage)', 'var(--font-inter)', 'sans-serif'],
        sans: ['var(--font-inter)', 'Noto Sans Devanagari', 'sans-serif'],
      },
      fontSize: {
        // §4.2 type scale
        xs: ['13px', '1.4'],
        sm: ['15px', '1.5'],
        base: ['15px', '1.5'],
        md: ['17px', '1.4'],
        lg: ['20px', '1.3'],
        xl: ['24px', '1.25'],
        '2xl': ['30px', '1.2'],
      },
      borderRadius: {
        card: '12px',
        button: '10px',
        chip: '999px',
      },
      boxShadow: {
        card: '0 1px 3px rgb(0 0 0 / .08)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}

export default config
