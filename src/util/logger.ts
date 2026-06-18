/**
 * Tiny structured logger. Emits one JSON object per line to stdout (info/debug)
 * or stderr (warn/error) so the daemon can redirect each stream to a log file.
 * Secrets are redacted defensively before serialization.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_KEYS = new Set(
  [
    "authorization",
    "x-api-key",
    "api_key",
    "apikey",
    "apikeyenv",
    "access_token",
    "refresh_token",
    "id_token",
    "tokens",
    "password",
    "secret",
    "cookie",
  ].map((k) => k.toLowerCase()),
);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function envLevel(): LogLevel {
  const raw = process.env.FUSION_LOG_LEVEL?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function makeLogger(bindings: Record<string, unknown>, minLevel: LogLevel): Logger {
  const min = LEVELS[minLevel];
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[level] < min) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...bindings,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    const line = JSON.stringify(record);
    if (level === "warn" || level === "error") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (extra) => makeLogger({ ...bindings, ...extra }, minLevel),
  };
}

export const logger: Logger = makeLogger({}, envLevel());
