import assert from "node:assert/strict";
import test from "node:test";
import { CORE_API_VERSION, validatePluginManifest } from "../src/plugins/spi.js";

test("plugin manifest compatibility follows the v1 core API major", () => {
  assert.equal(CORE_API_VERSION, "1.0.0");
  assert.deepEqual(
    validatePluginManifest({ name: "adapter", version: "1.0.0", coreApiVersion: "1.2.0", capabilities: ["decision-adapter"] }),
    { valid: true, errors: [] }
  );
  assert.equal(
    validatePluginManifest({ name: "legacy", version: "0.1.0", coreApiVersion: "0.1.0", capabilities: ["decision-adapter"] }).valid,
    false
  );
});
