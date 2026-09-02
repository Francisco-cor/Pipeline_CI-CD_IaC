// Runs all SQL migration files in order — transactional + advisory lock + version tracking.
// Fase 5: schema_migrations + pg_advisory_lock + BEGIN/COMMIT per file.
// Exit 0 = success → other containers start.
// Exit 1 = failure → other containers don't start, ECS marks deployment failed.

const fs = require('fs');
const path = require('path');

const { Client } = require('pg');

const ADVISORY_LOCK_KEY = 727727727; // arbitrary fixed key for migrations

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function runMigrations() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DATABASE_URL && process.env.DATABASE_URL.includes('amazonaws.com')
        ? { rejectUnauthorized: false }
        : false,
  });

  try {
    console.log('Connecting to database...');
    await client.connect();
    console.log('Connected. Acquiring advisory lock...');
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    console.log('Lock acquired. Ensuring schema_migrations...');
    await ensureMigrationsTable(client);

    const migrationsDir = path.join(__dirname, 'sql');
    const files = fs
      .readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    const { rows: applied } = await client.query('SELECT version FROM schema_migrations');
    const appliedSet = new Set(applied.map(r => r.version));

    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`Skipping already applied: ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      console.log(`Running migration: ${file}`);

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
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
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {
        // ignore
      });
    } catch (_) {
      // ignore unlock error
    }
    process.exit(1);
  } finally {
    await client.end().catch(() => {
      // ignore
    });
  }
}

runMigrations();
