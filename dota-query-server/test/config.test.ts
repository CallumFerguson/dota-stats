import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

const validEnvironment: NodeJS.ProcessEnv = {
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
  });

  it("rejects missing database settings", () => {
    const environment = { ...validEnvironment };
    delete environment.PGUSER;

    assert.throws(() => loadConfig(environment), /PGUSER must be set/);
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
