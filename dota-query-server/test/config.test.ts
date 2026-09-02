import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

const validEnvironment: NodeJS.ProcessEnv = {
  OPENROUTER_API_KEY: "test-openrouter-key",
  OPENROUTER_MODEL: "openai/gpt-5-mini",
  PGDATABASE: "dota_stats",
  PGHOST: "localhost",
  PGPASSWORD: "test-password",
  PGPORT: "5432",
  PGUSER: "dota_stats_reader",
};

describe("loadConfig", () => {
  it("uses the read-only session option and default HTTP port", () => {
    const config = loadConfig(validEnvironment);

    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 3001);
    assert.equal(config.database.database, "dota_stats");
    assert.equal(config.database.user, "dota_stats_reader");
    assert.equal(config.database.options, "-c default_transaction_read_only=on");
    assert.equal(config.databaseSchema, "public");
    assert.equal(config.openRouter.model, "openai/gpt-5-mini");
    assert.equal(config.openRouter.provider, undefined);
    assert.equal(config.openRouter.reasoningEffort, "low");
    assert.equal(config.openRouter.maxCompletionTokens, 2_000);
    assert.equal(config.openRouter.timeoutMs, 30_000);
  });

  it("rejects missing database settings", () => {
    const environment = { ...validEnvironment };
    delete environment.PGUSER;

    assert.throws(() => loadConfig(environment), /PGUSER must be set/);
  });

  it("requires the OpenRouter API key and model", () => {
    const withoutApiKey = { ...validEnvironment };
    delete withoutApiKey.OPENROUTER_API_KEY;

    assert.throws(
      () => loadConfig(withoutApiKey),
      /OPENROUTER_API_KEY must be set/,
    );

    const withoutModel = { ...validEnvironment };
    delete withoutModel.OPENROUTER_MODEL;

    assert.throws(
      () => loadConfig(withoutModel),
      /OPENROUTER_MODEL must be set/,
    );
  });

  it("loads optional OpenRouter routing and generation settings", () => {
    const config = loadConfig({
      ...validEnvironment,
      OPENROUTER_MAX_COMPLETION_TOKENS: "4096",
      OPENROUTER_PROVIDER: "anthropic",
      OPENROUTER_REASONING_EFFORT: "high",
      OPENROUTER_TIMEOUT_MS: "45000",
      PGSCHEMA: "analytics",
    });

    assert.equal(config.databaseSchema, "analytics");
    assert.equal(config.openRouter.maxCompletionTokens, 4_096);
    assert.equal(config.openRouter.provider, "anthropic");
    assert.equal(config.openRouter.reasoningEffort, "high");
    assert.equal(config.openRouter.timeoutMs, 45_000);
  });

  it("rejects invalid OpenRouter generation settings", () => {
    assert.throws(
      () =>
        loadConfig({
          ...validEnvironment,
          OPENROUTER_REASONING_EFFORT: "extreme",
        }),
      /OPENROUTER_REASONING_EFFORT must be one of/,
    );
    assert.throws(
      () =>
        loadConfig({
          ...validEnvironment,
          OPENROUTER_TIMEOUT_MS: "0",
        }),
      /OPENROUTER_TIMEOUT_MS must be a positive integer/,
    );
  });

  it("rejects invalid database and HTTP ports", () => {
    assert.throws(
      () => loadConfig({ ...validEnvironment, PGPORT: "not-a-port" }),
      /PGPORT must be an integer/,
    );
    assert.throws(
      () => loadConfig({ ...validEnvironment, PORT: "65536" }),
      /PORT must be an integer/,
    );
  });
});
