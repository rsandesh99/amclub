const { getDefaultConfig } = require('expo/metro-config')
const { withNativeWind } = require('nativewind/metro')
const path = require('path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

// Watch all files in the monorepo so Metro picks up changes in packages/
config.watchFolders = [workspaceRoot]

// Resolve modules from the project root first, then workspace root.
// This prevents Metro from hoisting multiple React versions.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]

// Allow Metro to resolve TypeScript source from workspace packages
// (they export `main: ./src/index.ts` — the "internal package" pattern)
config.resolver.sourceExts = [...config.resolver.sourceExts, 'ts', 'tsx', 'mts', 'cts']

module.exports = withNativeWind(config, { input: './global.css' })
