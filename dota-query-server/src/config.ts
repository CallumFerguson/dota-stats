import type { PoolConfig } from "pg";

const DATABASE_CONNECTION_TIMEOUT_MS = 10_000;

export interface AppConfig {
  database: PoolConfig;
  host: string;
  port: number;
}

function requireEnvironmentVariable(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name];

  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must be set and cannot be empty.`);
  }

  return value;
}

function parsePort(value: string, name: string): number {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }

  return port;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return {
    host: "127.0.0.1",
    port: parsePort(environment.PORT ?? "3001", "PORT"),
    database: {
      host: requireEnvironmentVariable(environment, "PGHOST"),
      port: parsePort(
        requireEnvironmentVariable(environment, "PGPORT"),
        "PGPORT",
      ),
      database: requireEnvironmentVariable(environment, "PGDATABASE"),
      user: requireEnvironmentVariable(environment, "PGUSER"),
      password: requireEnvironmentVariable(environment, "PGPASSWORD"),
      application_name: "dota-query-server",
      connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MS,
      max: 10,
      options: "-c default_transaction_read_only=on",
    },
  };
}
