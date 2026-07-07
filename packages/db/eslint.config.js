// Flat config (ESLint 9). Ops scripts talk to postgres.js rows (untyped),
// so no-explicit-any stays off here — typecheck strictness already covers
// the schema files (STATUS_AUDIT §4).
const tseslint = require('typescript-eslint')

module.exports = tseslint.config(...tseslint.configs.recommended, {
  ignores: ['dist/**', 'src/migrations/**'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
  },
})
