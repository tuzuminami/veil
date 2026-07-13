import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const advisoryLockId = 1946428871;
const defaultMigrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
const legacyMigrationVersion = "001_init.sql";
const legacyTables = {
  policy_versions: {
    columns: ["tenant_id", "policy_id", "version", "status", "content_hash", "bundle_json", "created_at", "created_by", "updated_at", "row_version", "published_at"],
    primaryKey: ["tenant_id", "policy_id", "version"]
  },
  decisions: {
    columns: ["tenant_id", "decision_id", "policy_id", "version", "action", "reason_codes_json", "obligations_json", "matched_rule_id", "input_hash", "evidence_hash", "correlation_id", "created_at", "created_by", "row_version"],
    primaryKey: ["tenant_id", "decision_id"]
  },
  audit_events: {
    columns: ["tenant_id", "audit_id", "actor_id", "action", "resource_type", "resource_id", "correlation_id", "reason", "evidence_hash", "created_at"],
    primaryKey: ["tenant_id", "audit_id"]
  },
  appeals: {
    columns: ["tenant_id", "appeal_id", "decision_id", "status", "reason", "correlation_id", "created_at", "created_by", "row_version"],
    primaryKey: ["tenant_id", "appeal_id"]
  },
  outbox_events: {
    columns: ["tenant_id", "event_id", "event_type", "resource_id", "correlation_id", "payload_json", "occurred_at", "published_at"],
    primaryKey: ["tenant_id", "event_id"]
  },
  idempotency_records: {
    columns: ["tenant_id", "idempotency_key", "response_json", "created_at"],
    primaryKey: ["tenant_id", "idempotency_key"]
  }
};

export class PostgresMigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PostgresMigrationError";
    this.code = code;
  }
}

export async function runPostgresMigrations(pool, { migrationsDirectory = defaultMigrationsDirectory } = {}) {
  if (typeof pool?.connect !== "function") {
    throw new TypeError("PostgreSQL migration runner requires a Pool with connect() so it can own a dedicated client.");
  }

  const migrations = await loadMigrations(migrationsDirectory);
  const client = await pool.connect();
  if (typeof client?.query !== "function" || typeof client?.release !== "function") {
    throw new TypeError("PostgreSQL migration runner requires Pool.connect() to return a releasable client with query().");
  }

  try {
    const appliedVersions = [];
    for (const migration of migrations) {
      if (await applyNextMigration(client, migration, migrations)) appliedVersions.push(migration.version);
    }
    return appliedVersions;
  } finally {
    client.release();
  }
}

async function loadMigrations(migrationsDirectory) {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && /^\d+_.+\.sql$/.test(entry.name) && !entry.name.endsWith(".down.sql"))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new PostgresMigrationError("MIGRATIONS_NOT_FOUND", `No forward SQL migrations found in ${migrationsDirectory}.`);
  }
  return Promise.all(names.map(async (version) => {
    const sql = await readFile(join(migrationsDirectory, version), "utf8");
    return { version, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}

async function applyNextMigration(client, migration, migrations) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [advisoryLockId]);
    const ledgerAlreadyExisted = await ledgerExists(client);
    await ensureLedger(client);
    const applied = await appliedMigrations(client);
    validateAppliedMigrations(applied, migrations);

    if (!ledgerAlreadyExisted && migration.version === legacyMigrationVersion && applied.length === 0) {
      const legacyState = await legacySchemaState(client);
      if (legacyState === "complete") {
        await recordMigration(client, migration);
        await client.query("COMMIT");
        return true;
      }
      if (legacyState === "incomplete") {
        throw new PostgresMigrationError(
          "LEGACY_SCHEMA_INCOMPLETE",
          "Pre-existing VEIL v0.2 schema is incomplete. Restore the required 001_init.sql tables, columns, primary keys, and appeals foreign key before baselining."
        );
      }
    }

    if (applied.some((recorded) => recorded.version === migration.version)) {
      await client.query("COMMIT");
      return false;
    }

    await client.query(migration.sql);
    await recordMigration(client, migration);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await rollback(client, error);
  }
}

async function ledgerExists(client) {
  const result = await client.query("SELECT to_regclass('veil_schema_migrations') IS NOT NULL AS exists");
  return result.rows[0].exists;
}

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS veil_schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function appliedMigrations(client) {
  const result = await client.query("SELECT version, checksum FROM veil_schema_migrations ORDER BY version");
  return result.rows;
}

function validateAppliedMigrations(applied, migrations) {
  const available = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const recorded of applied) {
    const migration = available.get(recorded.version);
    if (!migration) {
      throw new PostgresMigrationError(
        "UNKNOWN_APPLIED_MIGRATION",
        `Migration ledger contains unknown applied migration ${recorded.version}. Restore the expected migration files before retrying.`
      );
    }
    if (migration.checksum !== recorded.checksum) {
      throw new PostgresMigrationError(
        "MIGRATION_CHECKSUM_MISMATCH",
        `Migration ${recorded.version} changed after it was applied. Restore its original contents and add a new migration for further changes.`
      );
    }
  }
}

async function recordMigration(client, migration) {
  await client.query(
    "INSERT INTO veil_schema_migrations (version, checksum) VALUES ($1, $2)",
    [migration.version, migration.checksum]
  );
}

async function legacySchemaState(client) {
  const tableNames = Object.keys(legacyTables);
  const result = await client.query(`
    SELECT requested.table_name,
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.oid = current_schema()::regnamespace
          AND relation.relkind = 'r'
          AND relation.relname = requested.table_name
      ) AS exists,
      COALESCE((
        SELECT array_agg(attribute.attname ORDER BY attribute.attname)
        FROM pg_catalog.pg_attribute attribute
        JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.oid = current_schema()::regnamespace
          AND relation.relname = requested.table_name
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      ), ARRAY[]::text[]) AS columns,
      COALESCE((
        SELECT array_agg(attribute.attname ORDER BY key.ordinality)
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class relation ON relation.oid = con.conrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinality) ON true
        JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid AND attribute.attnum = key.attnum
        WHERE namespace.oid = current_schema()::regnamespace
          AND relation.relname = requested.table_name
          AND con.contype = 'p'
      ), ARRAY[]::text[]) AS primary_key
    FROM unnest($1::text[]) AS requested(table_name)
    ORDER BY requested.table_name
  `, [tableNames]);

  if (result.rows.every((row) => !row.exists)) return "absent";
  for (const row of result.rows) {
    const expected = legacyTables[row.table_name];
    if (!row.exists || !expected.columns.every((column) => row.columns.includes(column)) || !sameColumns(row.primary_key, expected.primaryKey)) {
      return "incomplete";
    }
  }

  const foreignKey = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class child ON child.oid = con.conrelid
      JOIN pg_catalog.pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
      JOIN pg_catalog.pg_class parent ON parent.oid = con.confrelid
      JOIN pg_catalog.pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
        WHERE con.contype = 'f'
        AND child_namespace.oid = current_schema()::regnamespace
        AND parent_namespace.oid = current_schema()::regnamespace
        AND child.relname = 'appeals'
        AND parent.relname = 'decisions'
        AND pg_catalog.pg_get_constraintdef(con.oid) = 'FOREIGN KEY (tenant_id, decision_id) REFERENCES decisions (tenant_id, decision_id)'
    ) AS exists
  `);
  return foreignKey.rows[0].exists ? "complete" : "incomplete";
}

function sameColumns(actual, expected) {
  return actual.length === expected.length && actual.every((column, index) => column === expected[index]);
}

async function rollback(client, error) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the migration failure; rollback may fail after a broken connection.
  }
  throw error;
}
