#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// scripts/commitlint.js — dependency-free conventional-commit checker.
//
// Usage:
//   node scripts/commitlint.js              # validate HEAD
//   node scripts/commitlint.js main..HEAD   # validate a branch range
//
// Rules come from commitlint.config.js so there is a single source of truth.
// If @commitlint/cli is installed later, the same config file works with it.

'use strict';

const { execFileSync } = require('node:child_process');

const config = require('../commitlint.config.js');

const HEADER_RE = /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<subject>.+)$/;
const MERGE_RE = /^Merge (branch|pull request|remote-tracking)/;

function rule(name) {
  const value = config.rules[name];
  if (!value) return null;
  const [level, applicable, ...args] = value;
  return { level, applicable, args };
}

function validate(message) {
  const [header = '', ...bodyLines] = message.replace(/\r\n/g, '\n').split('\n');
  const problems = [];

  if (MERGE_RE.test(header)) {
    return problems; // merge commits are created by GitHub, not by the author
  }

  const parsed = HEADER_RE.exec(header);

  const typeEmpty = rule('type-empty');
  if (typeEmpty && !parsed?.groups?.type) {
    problems.push({
      level: typeEmpty.level,
      text: 'header must start with "<type>(<scope>): <subject>"',
    });
  }

  const typeEnum = rule('type-enum');
  const allowedTypes = typeEnum?.args?.[0] || [];
  if (typeEnum && parsed?.groups?.type && !allowedTypes.includes(parsed.groups.type)) {
    problems.push({
      level: typeEnum.level,
      text: `type "${parsed.groups.type}" is not allowed (use: ${allowedTypes.join(', ')})`,
    });
  }

  const subjectEmpty = rule('subject-empty');
  if (subjectEmpty && !parsed?.groups?.subject) {
    problems.push({ level: subjectEmpty.level, text: 'subject must not be empty' });
  }

  const fullStop = rule('subject-full-stop');
  if (fullStop && parsed?.groups?.subject?.endsWith(fullStop.args[0])) {
    problems.push({
      level: fullStop.level,
      text: `subject must not end with "${fullStop.args[0]}"`,
    });
  }

  const maxHeader = rule('header-max-length');
  if (maxHeader && header.length > maxHeader.args[0]) {
    problems.push({
      level: maxHeader.level,
      text: `header is ${header.length} chars (max ${maxHeader.args[0]})`,
    });
  }

  const maxBody = rule('body-max-line-length');
  if (maxBody) {
    bodyLines.forEach((line, index) => {
      if (line.length > maxBody.args[0]) {
        problems.push({
          level: maxBody.level,
          text: `body line ${index + 2} is ${line.length} chars (max ${maxBody.args[0]})`,
        });
      }
    });
  }

  return problems;
}

function readCommits(target) {
  const isRange = target.includes('..');
  const args = isRange
    ? ['log', '--format=%H%x00%B%x00', target]
    : ['show', '-s', '--format=%H%x00%B', target];

  const output = execFileSync('git', args, { encoding: 'utf8' });
  return output
    .split('\0')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .reduce((commits, part) => {
      if (/^[0-9a-f]{7,40}$/.test(part)) {
        commits.push({ hash: part, message: '' });
      } else if (commits.length > 0) {
        commits[commits.length - 1].message = part;
      }
      return commits;
    }, []);
}

function main() {
  const target = process.argv[2] || 'HEAD';
  let commits;
  try {
    commits = readCommits(target);
  } catch (error) {
    console.error(`commitlint: cannot read git history for "${target}": ${error.message}`);
    process.exit(2);
  }

  if (commits.length === 0) {
    console.error(`commitlint: no commits found for "${target}"`);
    process.exit(2);
  }

  let errors = 0;
  for (const commit of commits) {
    const problems = validate(commit.message);
    for (const problem of problems) {
      const label = problem.level === 2 ? 'error' : 'warning';
      console.error(`${label} ${commit.hash.slice(0, 7)}: ${problem.text}`);
      if (problem.level === 2) errors += 1;
    }
  }

  if (errors > 0) {
    console.error('');
    console.error('Expected: tipo(scope): mensaje en imperativo — ver CONTRIBUTING.md.');
    process.exit(1);
  }

  console.log(`commitlint: ${commits.length} commit(s) OK (${target})`);
}

main();
