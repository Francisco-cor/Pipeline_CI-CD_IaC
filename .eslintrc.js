// SPDX-License-Identifier: MIT
// Shared ESLint config — applies to all services via eslint src/ in each package.json.
'use strict';

module.exports = {
  env: {
    node: true,
    es2021: true,
    jest: true,
  },
  extends: ['eslint:recommended', 'plugin:import/recommended'],
  plugins: ['import'],
  parserOptions: {
    ecmaVersion: 2021,
  },
  settings: {
    'import/resolver': {
      node: {
        extensions: ['.js', '.json'],
      },
    },
  },
  rules: {
    // Warn on console — logger.js is the only legit place for console usage.
    // Allow console in logger.js via override below.
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'import/order': [
      'error',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc', caseInsensitive: true },
      },
    ],
    'import/no-unresolved': 'error',
    'import/no-duplicates': 'warn',
  },
  overrides: [
    {
      files: ['**/logger.js', '**/migrations/run.js'],
      rules: {
        'no-console': 'off', // structured logger intentionally writes to stdout
      },
    },
  ],
};
