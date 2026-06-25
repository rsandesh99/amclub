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
        // §4.2 design tokens
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
