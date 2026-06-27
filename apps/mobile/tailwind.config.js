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
        success: '#1E8E5A',
        trust: '#1A6FBF',
        verified: '#1A6FBF', // verification badges ONLY
        danger: {
          DEFAULT: '#C73E3E',
          foreground: '#FFFFFF',
        },
        destructive: {
          DEFAULT: '#C73E3E',
          foreground: '#FFFFFF',
        },
        warning: {
          DEFAULT: '#B45309',
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
    },
  },
  plugins: [],
}
