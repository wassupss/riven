// The protocol is shared with the desktop app, file for file: it lives in
// ../src/renderer/src/lib/remote and is imported here as @riven/remote (see
// tsconfig "paths"). Metro has to be allowed to watch that folder, and to
// resolve that file's own imports (tweetnacl) from THIS project's modules.
const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
const shared = path.resolve(__dirname, '../src/renderer/src/lib/remote')

config.watchFolders = [...(config.watchFolders || []), shared]
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')]

// tweetnacl probes for Node's `crypto` when it finds no Web Crypto; that
// require would fail to bundle. Randomness comes from expo-crypto instead
// (src/lib/polyfills.ts), so the probe gets an empty module.
const resolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'crypto') return { type: 'empty' }
  return (resolveRequest || context.resolveRequest)(context, moduleName, platform)
}

module.exports = config
