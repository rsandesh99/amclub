/**
 * E13 — component tests for the mobile screens (jest-expo). pnpm stores
 * packages under node_modules/.pnpm/<name>@<ver>/ (scopes as @scope+name), so
 * the transform allow-list matches both layouts.
 */
const allow = [
  '(jest-)?react-native', '@react-native(-community)?', 'expo(nent)?', '@expo(nent)?', 'expo-.*',
  '@react-navigation', 'react-navigation', 'nativewind', 'react-native-css-interop', '@amclub',
].join('|')
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/__tests__/**/*.test.tsx'],
  transformIgnorePatterns: [`node_modules/(?!(?:\\.pnpm/)?(?:${allow})(?:[/+@]|$))`],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
  setupFiles: ['<rootDir>/__tests__/setup.ts'],
}
