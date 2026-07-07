// Flat config (ESLint 9) — the old `eslint src --ext .ts` invocation predates
// flat config and made root `pnpm lint` unrunnable (STATUS_AUDIT §4).
const tseslint = require('typescript-eslint')

module.exports = tseslint.config(...tseslint.configs.recommended, {
  ignores: ['dist/**'],
})
