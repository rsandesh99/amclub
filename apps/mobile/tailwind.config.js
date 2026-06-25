/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      // §4.2 design tokens — kept in sync with apps/web/tailwind.config.ts
      colors: {
        primary: {
          DEFAULT: '#1B4D3E',
          foreground: '#FFFFFF',
        },
        accent: {
          DEFAULT: '#F4A300',
          foreground: '#1A1D1A',
        },
        trust: '#1A6FBF',
        background: '#FAFAF7',
        surface: '#FFFFFF',
        danger: '#C73E3E',
        success: '#1E8E5A',
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
