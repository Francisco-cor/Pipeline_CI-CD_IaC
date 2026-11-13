// Runs all SQL migration files in order — transactional + advisory lock + version tracking.
// Fase 5: schema_migrations + pg_advisory_lock + BEGIN/COMMIT per file.
// Fase 1: SHA-256 checksum per applied migration + lock/statement timeouts.
// Exit 0 = success → other containers start.
// Exit 1 = failure → other containers don't start, ECS marks deployment failed.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { Client } = require('pg');

const ADVISORY_LOCK_KEY = 727727727; // arbitrary fixed key for migrations

// A rename must not re-run a migration that was already applied under its old
// name on existing databases. The SQL content is identical, so the version row
// is moved to the new filename instead.
const RENAMED_MIGRATIONS = {
  '007_outbox_inbox.sql': '008_outbox_inbox.sql',
};

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
}

function getSslConfig(connectionString) {
  const isRds = Boolean(connectionString && connectionString.includes('amazonaws.com'));
  if (!isRds) return false;
  const isProd = process.env.NODE_ENV === 'production' || process.env.ENVIRONMENT === 'prod';
  if (!isProd) return { rejectUnauthorized: false };
  try {
    const caInline = process.env.RDS_CA_BUNDLE;
    if (caInline) return { rejectUnauthorized: true, ca: caInline };
    const caPath =
      process.env.RDS_CA_PATH || path.join(__dirname, '..', 'certs', 'rds-ca-bundle.pem');
    const candidates = [
      caPath,
      '/app/certs/rds-ca-bundle.pem',
      path.join(process.cwd(), 'certs/rds-ca-bundle.pem'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const ca = fs.readFileSync(p, 'utf8');
        if (ca && ca.includes('BEGIN CERTIFICATE')) return { rejectUnauthorized: true, ca };
      }
    }
    return { rejectUnauthorized: true };
  } catch (_e) {
    return { rejectUnauthorized: true };
  }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function getMigrationFiles(migrationsDir) {
  return fs
    .readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

function migrationChecksum(migrationsDir, file) {
  return sha256(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
}

async function migrateRenamedVersions(client, appliedSet, files, migrationsDir) {
  for (const [oldName, newName] of Object.entries(RENAMED_MIGRATIONS)) {
    if (!appliedSet.has(oldName) || appliedSet.has(newName) || !files.includes(newName)) continue;
    const checksum = migrationChecksum(migrationsDir, newName);
    await client.query(
      'UPDATE schema_migrations SET version = $1, checksum = $2 WHERE version = $3',
      [newName, checksum, oldName]
    );
    appliedSet.delete(oldName);
    appliedSet.add(newName);
    console.log(`Renamed applied migration ${oldName} -> ${newName}`);
  }
}

async function runMigrations(opts = {}) {
  const migrationsDir = opts.migrationsDir || path.join(__dirname, 'sql');
  const client =
    opts.client ||
    new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: getSslConfig(process.env.DATABASE_URL),
    });

  const ownsClient = !opts.client;

  try {
    console.log('Connecting to database...');
    if (ownsClient) await client.connect();

    console.log('Connected. Setting migration timeouts...');
    await client.query(
      `SET lock_timeout = '${Number(process.env.MIGRATION_LOCK_TIMEOUT_MS) || 5000}ms'`
    );
    await client.query(
      `SET statement_timeout = '${Number(process.env.MIGRATION_STATEMENT_TIMEOUT_MS) || 60000}ms'`
    );

    console.log('Acquiring advisory lock...');
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    console.log('Lock acquired. Ensuring schema_migrations...');
    await ensureMigrationsTable(client);

    const files = getMigrationFiles(migrationsDir);
    const { rows: appliedRows } = await client.query(
      'SELECT version, checksum FROM schema_migrations'
    );
    const applied = new Map(appliedRows.map(r => [r.version, r.checksum]));
    const appliedSet = new Set(applied.keys());

    await migrateRenamedVersions(client, appliedSet, files, migrationsDir);

    // Files that no longer exist (e.g. the old renamed version on a database
    // migrated before this change) are reported but not treated as errors.
    for (const version of appliedSet) {
      if (!files.includes(version)) {
        console.warn(`Applied migration has no file on disk (ignored): ${version}`);
      }
    }

    for (const file of files) {
      const checksum = migrationChecksum(migrationsDir, file);

      if (appliedSet.has(file)) {
        const appliedChecksum = applied.get(file);
        if (!appliedChecksum) {
          // Backfill for databases migrated before checksums existed.
          await client.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [
            checksum,
            file,
          ]);
          console.log(`Backfilled checksum: ${file}`);
        } else if (appliedChecksum !== checksum) {
          throw new Error(
            `migration ${file} changed after being applied (checksum mismatch: ${appliedChecksum} != ${checksum})`
          );
        }
        console.log(`Skipping already applied: ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      console.log(`Running migration: ${file}`);

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
        console.log(`  ${file} completed`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {
          // ignore rollback error
        });
        throw new Error(`${file} failed: ${err.message}`);
      }
    }

    console.log('All migrations completed successfully.');
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    return { applied: files.length };
  } catch (err) {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {
        // ignore
      });
    } catch (_) {
      // ignore unlock error
    }
    throw err;
  } finally {
    if (ownsClient) {
      await client.end().catch(() => {
        // ignore
      });
    }
  }
}

async function main() {
  try {
    await runMigrations();
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ADVISORY_LOCK_KEY,
  RENAMED_MIGRATIONS,
  runMigrations,
  ensureMigrationsTable,
  getMigrationFiles,
  migrationChecksum,
  sha256,
};
