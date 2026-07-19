import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { buildDbPool } from "./pool.js";
import { logger } from "../logger.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

// distinct tracking table and lock id from user-service's (7264991), matching-service's
// (7264992), and doubt-service's (7264993), since this shares the same database -- must never
// collide
const TRACKING_TABLE = "resolution_service_schema_migrations";
const MIGRATION_LOCK_ID = 7264994;

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    const { rows } = await client.query(`SELECT name FROM ${TRACKING_TABLE}`);
    const applied = new Set(rows.map((r) => r.name));
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      logger.info("no pending migrations");
      return;
    }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO ${TRACKING_TABLE} (name) VALUES ($1)`, [file]);
        await client.query("COMMIT");
        logger.info({ migration: file }, "applied migration");
      } catch (err) {
        await client.query("ROLLBACK");
        logger.error({ migration: file, err }, "migration failed, rolled back");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    client.release();
  }
}

// run directly: `npm run migrate`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = buildDbPool();
  runMigrations(pool)
    .then(() => pool.end())
    .then(() => logger.info("migrations complete"))
    .catch((err) => {
      logger.error({ err }, "migration run failed");
      process.exit(1);
    });
}
