import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { Client } from "pg";
import YAML from "yaml";
import { PostgresVeilStore } from "../src/adapters/postgres-store.js";
import { VeilService } from "../src/application/veil-service.js";
import { PostgresMigrationError, runPostgresMigrations } from "../src/migrations/postgres-runner.js";

const databaseUrl = process.env.VEIL_TEST_DATABASE_URL;
const openapiSchemas = YAML.parse(readFileSync("openapi/openapi.yaml", "utf8")).components.schemas;

test("PostgreSQL migration runner owns locks, transactions, and ledger inserts", async () => {
  const migrationsDirectory = await mkdtemp(join(tmpdir(), "veil-migrations-"));
  const calls = [];
  let released = false;
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT version, checksum")) return { rows: [] };
      if (sql.startsWith("SELECT to_regclass")) return { rows: [{ exists: false }] };
      return { rows: [] };
    },
    release() {
      released = true;
    }
  };
  const pool = { async connect() { return client; } };
  try {
    await writeFile(join(migrationsDirectory, "001_create.sql"), "CREATE TABLE runner_test (id INTEGER PRIMARY KEY);\n");
    assert.deepEqual(await runPostgresMigrations(pool, { migrationsDirectory }), ["001_create.sql"]);
    assert.equal(calls[1].sql, "SELECT pg_advisory_xact_lock($1::bigint)");
    assert.equal(calls.filter((call) => call.sql === "BEGIN").length, 1);
    assert.equal(calls.filter((call) => call.sql === "COMMIT").length, 1);
    assert.equal(calls.some((call) => call.sql.includes("INSERT INTO veil_schema_migrations")), true);
    assert.equal(released, true);
  } finally {
    await rm(migrationsDirectory, { recursive: true, force: true });
  }
});

test("PostgreSQL migration runner rejects a direct Client", async () => {
  const client = new Client({ connectionString: "postgresql://unused" });
  client.connect = async () => undefined;
  await assert.rejects(
    runPostgresMigrations(client),
    (error) => error instanceof TypeError && error.message.includes("releasable client")
  );
});

test("PostgreSQL migration runner fails closed when a legacy baseline column or primary key is missing", async () => {
  const migrationsDirectory = await mkdtemp(join(tmpdir(), "veil-migrations-"));
  try {
    await writeFile(join(migrationsDirectory, "001_init.sql"), "SELECT 1;\n");
    for (const state of ["missing-column", "missing-primary-key"]) {
      const calls = [];
      const pool = createBaselineFakePool(state, calls);
      await assert.rejects(
        runPostgresMigrations(pool, { migrationsDirectory }),
        (error) => error instanceof PostgresMigrationError && error.code === "LEGACY_SCHEMA_INCOMPLETE"
      );
      assert.equal(calls.includes("ROLLBACK"), true, state);
      assert.equal(pool.released, true, state);
    }
  } finally {
    await rm(migrationsDirectory, { recursive: true, force: true });
  }
});

test("PostgreSQL migration runner supports fresh install, upgrade, and repeat execution", { skip: databaseUrl === undefined }, async () => {
  await withSchema(async (client, pool) => {
    assert.deepEqual(await runPostgresMigrations(pool), ["001_init.sql", "002_v1.sql"]);
    assert.deepEqual(await runPostgresMigrations(pool), []);
    assert.deepEqual(await ledgerVersions(client), ["001_init.sql", "002_v1.sql"]);
    assert.equal(await tableExists(client, "active_policy_bindings"), true);
    assert.equal(await columnExists(client, "decisions", "receipt_json"), true);
  });

  await withSchema(async (client, pool) => {
    await client.query(await readFile("migrations/001_init.sql", "utf8"));
    assert.deepEqual(await runPostgresMigrations(pool), ["001_init.sql", "002_v1.sql"]);
    assert.equal(await tableExists(client, "active_policy_bindings"), true);
    assert.deepEqual(await ledgerVersions(client), ["001_init.sql", "002_v1.sql"]);
  });
});

test("PostgreSQL migration runner preserves legacy v0.2 rows and supports v1 rollback", { skip: databaseUrl === undefined }, async () => {
  await withSchema(async (client, pool) => {
    await client.query(await readFile("migrations/001_init.sql", "utf8"));
    await client.query(
      `INSERT INTO decisions (
        tenant_id, decision_id, policy_id, version, action, reason_codes_json, obligations_json,
        input_hash, evidence_hash, correlation_id, created_at, created_by
      ) VALUES ('tenant-a', 'legacy-decision', 'legacy-policy', '0.2.0', 'BLOCK', '[]', '[]',
        'legacy-input', 'legacy-evidence', 'legacy-correlation', '2026-07-05T00:00:00.000Z', 'legacy')`
    );
    await client.query(
      `INSERT INTO idempotency_records (tenant_id, idempotency_key, response_json, created_at)
       VALUES ('tenant-a', 'tenant-a:decision:legacy-key', '{"id":"legacy-decision"}', '2026-07-05T00:00:00.000Z')`
    );

    await runPostgresMigrations(pool);
    const service = new VeilService(new PostgresVeilStore(client));
    const legacyDecision = await service.getDecision({
      tenantId: "tenant-a",
      actorId: "migration-test",
      scopes: ["decision:read"],
      correlationId: "migration-correlation"
    }, "legacy-decision");
    assert.equal(legacyDecision.legacy, true);
    assert.equal(validateOpenApiDecision(legacyDecision), true);
    const legacyIdempotency = await client.query("SELECT fingerprint FROM idempotency_records WHERE idempotency_key = 'tenant-a:decision:legacy-key'");
    assert.equal(legacyIdempotency.rows[0].fingerprint, null);

    await client.query(await readFile("migrations/002_v1.down.sql", "utf8"));
    assert.equal(await tableExists(client, "active_policy_bindings"), false);
    assert.equal(await columnExists(client, "decisions", "receipt_json"), false);
    assert.equal(await columnExists(client, "idempotency_records", "fingerprint"), false);
    assert.deepEqual(await ledgerVersions(client), ["001_init.sql"]);
  });
});

test("PostgreSQL migration runner fails closed for changed and unknown applied migrations", { skip: databaseUrl === undefined }, async () => {
  const migrationsDirectory = await mkdtemp(join(tmpdir(), "veil-migrations-"));
  try {
    await writeFile(join(migrationsDirectory, "001_create.sql"), "CREATE TABLE migration_test (id INTEGER PRIMARY KEY);\n");
    await withSchema(async (client, pool) => {
      await runPostgresMigrations(pool, { migrationsDirectory });
      await writeFile(join(migrationsDirectory, "001_create.sql"), "CREATE TABLE migration_test (id BIGINT PRIMARY KEY);\n");
      await assert.rejects(
        runPostgresMigrations(pool, { migrationsDirectory }),
        (error) => error instanceof PostgresMigrationError && error.code === "MIGRATION_CHECKSUM_MISMATCH" && error.message.includes("add a new migration")
      );
    });

    await withSchema(async (client, pool) => {
      await client.query(`CREATE TABLE veil_schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await client.query("INSERT INTO veil_schema_migrations (version, checksum) VALUES ('999_missing.sql', 'missing')");
      await assert.rejects(
        runPostgresMigrations(pool, { migrationsDirectory }),
        (error) => error instanceof PostgresMigrationError && error.code === "UNKNOWN_APPLIED_MIGRATION" && error.message.includes("Restore the expected migration files")
      );
    });
  } finally {
    await rm(migrationsDirectory, { recursive: true, force: true });
  }
});

test("PostgreSQL migration runner retries failed work and serializes concurrent deployments", { skip: databaseUrl === undefined }, async () => {
  const migrationsDirectory = await mkdtemp(join(tmpdir(), "veil-migrations-"));
  try {
    await writeFile(join(migrationsDirectory, "001_create.sql"), "CREATE TABLE retry_test (id INTEGER PRIMARY KEY);\n");
    await writeFile(join(migrationsDirectory, "002_retry.sql"), "CREATE TABLE missing_schema.retry_test (id INTEGER);\n");
    await withSchema(async (client, pool) => {
      await assert.rejects(runPostgresMigrations(pool, { migrationsDirectory }), /missing_schema/);
      assert.deepEqual(await ledgerVersions(client), ["001_create.sql"]);
      await writeFile(join(migrationsDirectory, "002_retry.sql"), "ALTER TABLE retry_test ADD COLUMN retried BOOLEAN NOT NULL DEFAULT false;\n");
      assert.deepEqual(await runPostgresMigrations(pool, { migrationsDirectory }), ["002_retry.sql"]);
      assert.equal(await columnExists(client, "retry_test", "retried"), true);
    });

    await writeFile(join(migrationsDirectory, "001_create.sql"), "SELECT pg_sleep(0.15); CREATE TABLE concurrent_test (id INTEGER PRIMARY KEY);\n");
    await writeFile(join(migrationsDirectory, "002_retry.sql"), "ALTER TABLE concurrent_test ADD COLUMN complete BOOLEAN NOT NULL DEFAULT false;\n");
    await withConcurrentClients(async (first, second) => {
      const results = await Promise.all([
        runPostgresMigrations(createPoolWrapper(first), { migrationsDirectory }),
        runPostgresMigrations(createPoolWrapper(second), { migrationsDirectory })
      ]);
      assert.equal(results.flat().length, 2);
      assert.deepEqual(await ledgerVersions(first), ["001_create.sql", "002_retry.sql"]);
      assert.equal(await columnExists(first, "concurrent_test", "complete"), true);
    });
  } finally {
    await rm(migrationsDirectory, { recursive: true, force: true });
  }
});

async function withSchema(work) {
  const client = new Client({ connectionString: databaseUrl });
  const schema = `veil_migration_${randomUUID().replaceAll("-", "")}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await useSchema(client, schema);
    await work(client, createPoolWrapper(client, schema));
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
}

function createPoolWrapper(client, schema) {
  return {
    async connect() {
      if (schema) await useSchema(client, schema);
      return { query: client.query.bind(client), release() {} };
    }
  };
}

function createBaselineFakePool(state, calls) {
  const definitions = {
    policy_versions: {
      columns: ["tenant_id", "policy_id", "version", "status", "content_hash", "bundle_json", "created_at", "created_by", "updated_at", "row_version", "published_at"],
      primary_key: ["tenant_id", "policy_id", "version"]
    },
    decisions: {
      columns: ["tenant_id", "decision_id", "policy_id", "version", "action", "reason_codes_json", "obligations_json", "matched_rule_id", "input_hash", "evidence_hash", "correlation_id", "created_at", "created_by", "row_version"],
      primary_key: ["tenant_id", "decision_id"]
    },
    audit_events: {
      columns: ["tenant_id", "audit_id", "actor_id", "action", "resource_type", "resource_id", "correlation_id", "reason", "evidence_hash", "created_at"],
      primary_key: ["tenant_id", "audit_id"]
    },
    appeals: {
      columns: ["tenant_id", "appeal_id", "decision_id", "status", "reason", "correlation_id", "created_at", "created_by", "row_version"],
      primary_key: ["tenant_id", "appeal_id"]
    },
    outbox_events: {
      columns: ["tenant_id", "event_id", "event_type", "resource_id", "correlation_id", "payload_json", "occurred_at", "published_at"],
      primary_key: ["tenant_id", "event_id"]
    },
    idempotency_records: {
      columns: ["tenant_id", "idempotency_key", "response_json", "created_at"],
      primary_key: ["tenant_id", "idempotency_key"]
    }
  };
  const rows = Object.entries(definitions).map(([table_name, definition]) => ({
    table_name,
    exists: true,
    columns: state === "missing-column" && table_name === "decisions" ? definition.columns.filter((column) => column !== "created_by") : definition.columns,
    primary_key: state === "missing-primary-key" && table_name === "policy_versions" ? [] : definition.primary_key
  }));
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith("SELECT to_regclass")) return { rows: [{ exists: false }] };
      if (sql.startsWith("SELECT version, checksum")) return { rows: [] };
      if (sql.includes("FROM unnest($1::text[])")) return { rows };
      return { rows: [] };
    },
    release() { pool.released = true; }
  };
  const pool = { released: false, async connect() { return client; } };
  return pool;
}

async function withConcurrentClients(work) {
  const schema = `veil_migration_${randomUUID().replaceAll("-", "")}`;
  const first = new Client({ connectionString: databaseUrl });
  const second = new Client({ connectionString: databaseUrl });
  await Promise.all([first.connect(), second.connect()]);
  try {
    await first.query(`CREATE SCHEMA "${schema}"`);
    await Promise.all([useSchema(first, schema), useSchema(second, schema)]);
    await work(first, second);
  } finally {
    await first.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await Promise.all([first.end(), second.end()]);
  }
}

function useSchema(client, schema) {
  return client.query("SELECT set_config('search_path', $1, false)", [`"${schema}"`]);
}

async function ledgerVersions(client) {
  const result = await client.query("SELECT version FROM veil_schema_migrations ORDER BY version");
  return result.rows.map((row) => row.version);
}

async function tableExists(client, table) {
  const result = await client.query("SELECT to_regclass($1) IS NOT NULL AS exists", [table]);
  return result.rows[0].exists;
}

async function columnExists(client, table, column) {
  const result = await client.query(
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2) AS exists",
    [table, column]
  );
  return result.rows[0].exists;
}

function validateOpenApiDecision(decision) {
  const dereference = (schema) => {
    if (schema?.$ref) return dereference(openapiSchemas[schema.$ref.split("/").at(-1)]);
    if (Array.isArray(schema)) return schema.map(dereference);
    if (schema && typeof schema === "object") {
      return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, dereference(value)]));
    }
    return schema;
  };
  const validate = new Ajv2020({ strict: true, validateFormats: false }).compile({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...dereference(openapiSchemas.Decision)
  });
  return validate(decision);
}
