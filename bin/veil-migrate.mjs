#!/usr/bin/env node
import { Pool } from "pg";
import { runPostgresMigrations } from "../src/migrations/postgres-runner.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to run PostgreSQL migrations.");

const pool = new Pool({ connectionString: databaseUrl });
try {
  const applied = await runPostgresMigrations(pool);
  console.log(applied.length === 0 ? "PostgreSQL migrations are already current." : `Applied PostgreSQL migrations: ${applied.join(", ")}`);
} finally {
  await pool.end();
}
