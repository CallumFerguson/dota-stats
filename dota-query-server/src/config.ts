import type { PoolConfig } from "pg";

const DATABASE_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_OPENROUTER_TIMEOUT_MS = 30_000;
const DEFAULT_OPENROUTER_MAX_COMPLETION_TOKENS = 2_000;

export const OPENROUTER_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type OpenRouterReasoningEffort =
  (typeof OPENROUTER_REASONING_EFFORTS)[number];

export interface OpenRouterConfig {
  apiKey: string;
  maxCompletionTokens: number;
  model: string;
  provider?: string;
  reasoningEffort: OpenRouterReasoningEffort;
  timeoutMs: number;
}

export interface AppConfig {
  database: PoolConfig;
  databaseSchema: string;
  host: string;
  openRouter: OpenRouterConfig;
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

function parsePositiveInteger(value: string, name: string): number {
  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsedValue;
}

function parseReasoningEffort(value: string): OpenRouterReasoningEffort {
  if (
    !OPENROUTER_REASONING_EFFORTS.includes(
      value as OpenRouterReasoningEffort,
    )
  ) {
    throw new Error(
      `OPENROUTER_REASONING_EFFORT must be one of: ${OPENROUTER_REASONING_EFFORTS.join(", ")}.`,
    );
  }

  return value as OpenRouterReasoningEffort;
}

function optionalEnvironmentVariable(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return {
    host: "127.0.0.1",
    port: parsePort(environment.PORT ?? "3001", "PORT"),
    databaseSchema: environment.PGSCHEMA?.trim() || "public",
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
    openRouter: {
      apiKey: requireEnvironmentVariable(environment, "OPENROUTER_API_KEY"),
      maxCompletionTokens: parsePositiveInteger(
        environment.OPENROUTER_MAX_COMPLETION_TOKENS ??
          String(DEFAULT_OPENROUTER_MAX_COMPLETION_TOKENS),
        "OPENROUTER_MAX_COMPLETION_TOKENS",
      ),
      model: requireEnvironmentVariable(environment, "OPENROUTER_MODEL"),
      provider: optionalEnvironmentVariable(
        environment,
        "OPENROUTER_PROVIDER",
      ),
      reasoningEffort: parseReasoningEffort(
        environment.OPENROUTER_REASONING_EFFORT ?? "low",
      ),
      timeoutMs: parsePositiveInteger(
        environment.OPENROUTER_TIMEOUT_MS ??
          String(DEFAULT_OPENROUTER_TIMEOUT_MS),
        "OPENROUTER_TIMEOUT_MS",
      ),
    },
  };
}
