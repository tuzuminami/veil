import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { Client } from "pg";
import YAML from "yaml";
import { PostgresVeilStore } from "../src/adapters/postgres-store.js";
import { VeilService } from "../src/application/veil-service.js";

const databaseUrl = process.env.VEIL_TEST_DATABASE_URL;
const openapiSchemas = YAML.parse(readFileSync("openapi/openapi.yaml", "utf8")).components.schemas;

test("PostgreSQL v1 migrations upgrade and down cleanly", { skip: databaseUrl === undefined }, async () => {
  const client = new Client({ connectionString: databaseUrl });
  const schema = `veil_migration_${randomUUID().replaceAll("-", "")}`;

  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query("SELECT set_config('search_path', $1, false)", [`"${schema}"`]);

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
    await client.query(await readFile("migrations/002_v1.sql", "utf8"));

    for (const table of [
      "policy_versions",
      "decisions",
      "audit_events",
      "appeals",
      "outbox_events",
      "idempotency_records",
      "active_policy_bindings"
    ]) {
      assert.equal(await tableExists(client, table), true, `expected ${table} after upgrade`);
    }
    assert.equal(await columnExists(client, "decisions", "receipt_json"), true);
    assert.equal(await columnExists(client, "idempotency_records", "fingerprint"), true);
    assert.equal(await indexExists(client, "decisions_tenant_created_idx"), true);
    assert.equal(await indexExists(client, "audit_events_tenant_created_idx"), true);
    const legacy = await client.query("SELECT receipt_json FROM decisions WHERE decision_id = 'legacy-decision'");
    assert.equal(legacy.rows[0].receipt_json, null);
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
    assert.equal(await indexExists(client, "decisions_tenant_created_idx"), false);
    assert.equal(await indexExists(client, "audit_events_tenant_created_idx"), false);
    assert.equal(await tableExists(client, "policy_versions"), true);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});

test("a failing v1 migration rolls back its preceding DDL", { skip: databaseUrl === undefined }, async () => {
  const client = new Client({ connectionString: databaseUrl });
  const schema = `veil_migration_${randomUUID().replaceAll("-", "")}`;

  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query("SELECT set_config('search_path', $1, false)", [`"${schema}"`]);

    await client.query(await readFile("migrations/001_init.sql", "utf8"));
    const migration = await readFile("migrations/002_v1.sql", "utf8");
    const failingMigration = migration.replace("ALTER TABLE decisions", "ALTER TABLE deliberately_missing_decisions");
    await assert.rejects(
      client.query(failingMigration),
      /deliberately_missing_decisions/
    );
    await client.query("ROLLBACK");

    assert.equal(await tableExists(client, "active_policy_bindings"), false);
    assert.equal(await columnExists(client, "idempotency_records", "fingerprint"), false);
    assert.equal(await columnExists(client, "decisions", "receipt_json"), false);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});

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

async function indexExists(client, index) {
  const result = await client.query(
    "SELECT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relname = $1 AND relkind = 'i') AS exists",
    [index]
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
