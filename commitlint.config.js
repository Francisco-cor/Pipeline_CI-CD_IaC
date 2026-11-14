// SPDX-License-Identifier: MIT
// commitlint.config.js — conventional commits, no external preset required.
//
// `make commitlint` runs scripts/commitlint.js, which reads the rules below.
// The shape is deliberately compatible with @commitlint/config-conventional,
// so installing @commitlint/cli later only needs a config that extends this
// file; no rule has to be rewritten.

'use strict';

module.exports = {
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'docs',
        'feat',
        'fix',
        'infra',
        'perf',
        'refactor',
        'revert',
        'sec',
        'style',
        'test',
      ],
    ],
    'type-empty': [2, 'never'],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 100],
    // Body lines are a warning: links and tables often exceed 100 columns.
    'body-max-line-length': [1, 'always', 100],
  },
};
