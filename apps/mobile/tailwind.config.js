/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      // §4.2 semantic design tokens — kept in sync with apps/web/tailwind.config.ts
      colors: {
        primary: {
          DEFAULT: '#1B4D3E',
          foreground: '#FFFFFF',
        },
        accent: {
          DEFAULT: '#F4A300',
          foreground: '#1A1D1A',
        },
        success: '#14724A', // ≥4.5:1 on success-soft (kept in sync with web a11y pass)
        trust: '#155C9E',
        verified: '#155C9E', // verification badges ONLY
        danger: {
          DEFAULT: '#C73E3E',
          foreground: '#FFFFFF',
        },
        destructive: {
          DEFAULT: '#C73E3E',
          foreground: '#FFFFFF',
        },
        warning: {
          DEFAULT: '#92400E',
          foreground: '#FFFFFF',
        },
        background: '#FAFAF7',
        surface: '#FFFFFF',
        border: '#E6E7E3',
        muted: '#F3F4F1',
        foreground: {
          DEFAULT: '#1A1D1A',
          secondary: '#5C645C',
        },
      },
      fontFamily: {
        sans: ['Inter', 'System'],
        display: ['Inter', 'System'],
      },
      // §4.2 type scale — kept in sync with apps/web/tailwind.config.ts so
      // headings/card-titles/prices share the same hierarchy. (letterSpacing is
      // omitted here — RN uses px, not em; the visual difference is negligible.)
      fontSize: {
        xs: ['13px', { lineHeight: '18px' }],
        sm: ['15px', { lineHeight: '22px' }],
        base: ['15px', { lineHeight: '22px' }],
        md: ['17px', { lineHeight: '24px' }],
        lg: ['20px', { lineHeight: '26px' }],
        xl: ['24px', { lineHeight: '30px' }],
        '2xl': ['30px', { lineHeight: '36px' }],
        '3xl': ['36px', { lineHeight: '42px' }],
        '4xl': ['44px', { lineHeight: '48px' }],
      },
      borderRadius: {
        card: '12px',
        button: '10px',
        chip: '999px',
      },
      // NOTE: the web elevation/box-shadow scale (resting/hover/lg/pressed) is
      // WEB-ONLY. React Native has no CSS box-shadow or :hover; elevation is
      // applied per-component via `style={{ elevation, shadowColor, … }}` or a
      // shared RN shadow preset. Do not expect `shadow-hover` etc. to work here.
    },
  },
  plugins: [],
}
