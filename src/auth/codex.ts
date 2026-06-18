import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { asObject, getObject, getString } from "../adapters/json.js";
import { codexAuthFile } from "../config/paths.js";
import { logger } from "../util/logger.js";
import { decodeJwtPayload, extractAccountIdFromClaims, isExpired } from "./jwt.js";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
export const CODEX_AUTHORIZE_URL = `${CODEX_ISSUER}/oauth/authorize`;
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

export interface CodexTokens {
  access_token: string;
  id_token: string;
  refresh_token: string;
  account_id?: string;
}

export interface CodexAuthFile {
  last_refresh?: string;
  OPENAI_API_KEY?: string | null;
  tokens: CodexTokens;
}

export class CodexAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAuthError";
  }
}

function readAuthFile(path: string): CodexAuthFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new CodexAuthError(
      `No codex credentials at ${path}. Run \`codex login\` or \`fusion auth login\`.`,
    );
  }
  const parsed: unknown = JSON.parse(raw);
  const tokens = getObject(parsed, "tokens");
  const accessToken = getString(tokens, "access_token");
  const refreshToken = getString(tokens, "refresh_token");
  if (!accessToken || !refreshToken) {
    throw new CodexAuthError(`Codex credentials at ${path} are missing tokens. Re-run login.`);
  }
  const obj = asObject(parsed);
  const accountId = getString(tokens, "account_id");
  return {
    ...(typeof obj.last_refresh === "string" ? { last_refresh: obj.last_refresh } : {}),
    OPENAI_API_KEY: typeof obj.OPENAI_API_KEY === "string" ? obj.OPENAI_API_KEY : null,
    tokens: {
      access_token: accessToken,
      id_token: getString(tokens, "id_token") ?? "",
      refresh_token: refreshToken,
      ...(accountId ? { account_id: accountId } : {}),
    },
  };
}

/** Atomic write (temp + rename) so a concurrent reader never sees a partial file. */
function writeAuthFile(path: string, data: CodexAuthFile): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

interface RefreshResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
}

async function refreshTokens(refreshToken: string): Promise<RefreshResponse> {
  const res = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 400 || res.status === 401) {
      throw new CodexAuthError(
        `Codex token refresh rejected (${res.status}). Re-run \`fusion auth login\`. ${body.slice(0, 200)}`,
      );
    }
    throw new CodexAuthError(`Codex token refresh failed: HTTP ${res.status}`);
  }
  const parsed: unknown = await res.json();
  const access = getString(parsed, "access_token");
  if (!access) throw new CodexAuthError("Codex token refresh returned no access_token");
  const idToken = getString(parsed, "id_token");
  const newRefresh = getString(parsed, "refresh_token");
  return {
    access_token: access,
    ...(idToken ? { id_token: idToken } : {}),
    ...(newRefresh ? { refresh_token: newRefresh } : {}),
  };
}

export interface CodexCredential {
  accessToken: string;
  accountId: string | undefined;
}

/**
 * Reads + refreshes the codex login. A single in-flight refresh promise prevents
 * concurrent requests from double-refreshing and clobbering the rotated refresh
 * token. The refreshed file keeps codex's format so the codex CLI keeps working.
 */
export class CodexAuth {
  private inflight: Promise<CodexCredential> | null = null;

  constructor(private readonly path: string = codexAuthFile()) {}

  async getCredential(): Promise<CodexCredential> {
    const file = readAuthFile(this.path);
    if (!isExpired(file.tokens.access_token)) {
      return { accessToken: file.tokens.access_token, accountId: this.accountId(file) };
    }
    this.inflight ??= this.doRefresh(file).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Force a refresh (used after a 401 in case another process rotated the token). */
  async forceRefresh(): Promise<CodexCredential> {
    const file = readAuthFile(this.path);
    // Another process may have already refreshed; if the on-disk token is fresh, use it.
    if (!isExpired(file.tokens.access_token, 0)) {
      return { accessToken: file.tokens.access_token, accountId: this.accountId(file) };
    }
    this.inflight ??= this.doRefresh(file).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(file: CodexAuthFile): Promise<CodexCredential> {
    logger.info("refreshing codex access token");
    const refreshed = await refreshTokens(file.tokens.refresh_token);
    const updated: CodexAuthFile = {
      last_refresh: new Date().toISOString(),
      OPENAI_API_KEY: file.OPENAI_API_KEY ?? null,
      tokens: {
        access_token: refreshed.access_token,
        id_token: refreshed.id_token ?? file.tokens.id_token,
        refresh_token: refreshed.refresh_token ?? file.tokens.refresh_token,
        ...(file.tokens.account_id ? { account_id: file.tokens.account_id } : {}),
      },
    };
    writeAuthFile(this.path, updated);
    return { accessToken: updated.tokens.access_token, accountId: this.accountId(updated) };
  }

  private accountId(file: CodexAuthFile): string | undefined {
    if (file.tokens.account_id) return file.tokens.account_id;
    return (
      extractAccountIdFromClaims(decodeJwtPayload(file.tokens.id_token)) ??
      extractAccountIdFromClaims(decodeJwtPayload(file.tokens.access_token))
    );
  }
}
