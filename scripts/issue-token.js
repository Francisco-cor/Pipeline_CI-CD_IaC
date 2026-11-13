#!/usr/bin/env node
'use strict';

// Dev-only JWT issuer for local API testing.
//
//   export JWT_SECRET=dev-only-secret
//   node scripts/issue-token.js --sub alice --role admin --tenant acme
//   curl -H "Authorization: Bearer $(node scripts/issue-token.js ...)" ...
//
// Roles: reader (GET), operator (GET + POST/PUT), admin (also DELETE).
// The token is printed to stdout so it can be piped into curl.
//
// RS256 is also supported for parity with production: set JWT_PRIVATE_KEY to
// an inline PEM or JWT_PRIVATE_KEY_PATH to a file (JWT_PUBLIC_KEY must be the
// matching public key in the service).

const fs = require('fs');

const jwt = require('jsonwebtoken');

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    [
      'Usage: node scripts/issue-token.js --sub <subject> --role <reader|operator|admin> [options]',
      '',
      'Options:',
      '  --sub <id>          Subject / user id (default: dev-user)',
      '  --role <role>       reader | operator | admin (default: reader)',
      '  --tenant <id>       Tenant id claim (optional)',
      '  --scopes <list>     Comma-separated scopes (optional)',
      '  --expires <ttl>     jsonwebtoken expiresIn value (default: 1h)',
      '',
      'Environment:',
      '  JWT_SECRET          HS256 signing secret (required unless a private key is set)',
      '  JWT_PRIVATE_KEY     RS256 private key (inline PEM)',
      '  JWT_PRIVATE_KEY_PATH  RS256 private key file',
      '',
    ].join('\n')
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      usage(`unknown argument: ${arg}`);
      process.exit(2);
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      usage(`missing value for ${arg}`);
      process.exit(2);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function readPrivateKey() {
  if (process.env.JWT_PRIVATE_KEY) return process.env.JWT_PRIVATE_KEY.replace(/\\n/g, '\n');
  if (process.env.JWT_PRIVATE_KEY_PATH)
    return fs.readFileSync(process.env.JWT_PRIVATE_KEY_PATH, 'utf8');
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const role = String(args.role || 'reader').toLowerCase();
  if (!['reader', 'operator', 'admin'].includes(role)) {
    usage(`invalid role: ${role}`);
    process.exit(2);
  }

  const payload = {
    sub: args.sub || 'dev-user',
    role,
    ...(args.tenant ? { tenant_id: args.tenant } : {}),
    ...(args.scopes
      ? {
          scopes: String(args.scopes)
            .split(',')
            .map(scope => scope.trim())
            .filter(Boolean),
        }
      : {}),
  };

  const options = { expiresIn: args.expires || '1h' };
  const privateKey = readPrivateKey();

  let token;
  if (privateKey) {
    token = jwt.sign(payload, privateKey, { ...options, algorithm: 'RS256' });
  } else {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      usage(
        'JWT_SECRET is required for HS256 (or set JWT_PRIVATE_KEY/JWT_PRIVATE_KEY_PATH for RS256)'
      );
      process.exit(2);
    }
    token = jwt.sign(payload, secret, { ...options, algorithm: 'HS256' });
  }

  process.stdout.write(`${token}\n`);
}

main();
