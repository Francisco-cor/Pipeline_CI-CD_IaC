// Shared ESLint config — applies to all services via eslint src/ in each package.json.
// Keep rules minimal: this is a portfolio project, not a large team codebase.
'use strict';

module.exports = {
  env: {
    node: true,
    es2021: true,
    jest: true,
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 2021,
  },
  rules: {
    'no-console': 'off',        // Services log via console / logger
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
};
