// Runs all SQL migration files in order.
// Designed to be idempotent (uses IF NOT EXISTS everywhere).
// Exit 0 = success → other containers start.
// Exit 1 = failure → other containers don't start, ECS marks deployment failed.

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigrations() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    console.log('Connecting to database...');
    await client.connect();
    console.log('Connected. Running migrations...');

    // Get all .sql files sorted alphabetically (001_, 002_, ...)
    const migrationsDir = path.join(__dirname, 'sql');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      console.log(`Running migration: ${file}`);
      await client.query(sql);
      console.log(`  ${file} completed`);
    }

    console.log('All migrations completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

runMigrations();
