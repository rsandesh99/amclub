/** @type {import('@babel/core').TransformOptions} */
module.exports = function (api) {
  api.cache(true)
  // Jest (E13 component tests; jest sets NODE_ENV=test in its own process) renders plain React Native:
  // className passes through untouched. Metro never runs with NODE_ENV=test.
  if (process.env.NODE_ENV === 'test') return { presets: ['babel-preset-expo'] }
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
  }
}
