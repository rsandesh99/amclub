// Flat config (ESLint 9). .cjs because this app is "type": "module".
const tseslint = require('typescript-eslint')

module.exports = tseslint.config(...tseslint.configs.recommended, {
  ignores: ['dist/**'],
})
