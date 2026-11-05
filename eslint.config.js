const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'src/*.html', 'docs/**'],
  },
  js.configs.recommended,
  {
    // This file itself, and other root-level Node config/scripts
    files: ['*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
  {
    // Backend: Node/CommonJS
    files: ['server/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none' }],
    },
  },
  {
    // Frontend: browser scripts served as-is (no bundler), with a UMD-style
    // module.exports fallback so the same file is also require()-able from
    // the server/*.test.js suite.
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        module: 'readonly',
        require: 'readonly',
        WaveSurfer: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none' }],
    },
  },
  {
    // Consumes the ListenTimeTracker/AudioAdSpot globals the two files above attach to `window`
    files: ['src/audio-player.js'],
    languageOptions: {
      globals: { ListenTimeTracker: 'readonly', AudioAdSpot: 'readonly' },
    },
  },
];
