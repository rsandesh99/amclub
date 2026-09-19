// Flat config (ESLint 9) — mirrors packages/shared.
const tseslint = require('typescript-eslint')

module.exports = tseslint.config(...tseslint.configs.recommended, {
  ignores: ['dist/**'],
})
