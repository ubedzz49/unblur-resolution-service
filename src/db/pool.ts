import { Pool } from "pg";

export function buildDbPool(): Pool {
  return new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    // RDS enforces TLS in transit; full chain verification (RDS CA bundle) is a follow-up
    // hardening item, same as noted for user-service/matching-service/doubt-service
    ssl: process.env.DB_SSL === "false" ? undefined : { rejectUnauthorized: false },
  });
}
