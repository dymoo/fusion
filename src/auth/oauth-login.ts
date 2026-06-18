import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

import { getString } from "../adapters/json.js";
import { codexAuthFile } from "../config/paths.js";
import {
  CODEX_AUTHORIZE_URL,
  CODEX_CLIENT_ID,
  CODEX_TOKEN_URL,
  type CodexAuthFile,
} from "./codex.js";
import { decodeJwtPayload, extractAccountIdFromClaims } from "./jwt.js";

const OAUTH_PORT = 1455;
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}/auth/callback`;

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Fall back to printing the URL (handled by caller).
  }
}

interface TokenExchange {
  access_token: string;
  id_token: string;
  refresh_token: string;
}

async function exchangeCode(code: string, verifier: string): Promise<TokenExchange> {
  const res = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CODEX_CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Token exchange failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const parsed: unknown = await res.json();
  return {
    access_token: getString(parsed, "access_token") ?? "",
    id_token: getString(parsed, "id_token") ?? "",
    refresh_token: getString(parsed, "refresh_token") ?? "",
  };
}

/**
 * Run the PKCE loopback login flow and persist tokens to ~/.codex/auth.json in
 * codex's format. Resolves when login completes; rejects on error/timeout.
 */
export function runLogin(
  timeoutMs = 300_000,
): Promise<{ accountId: string | undefined; path: string }> {
  const { verifier, challenge } = pkce();
  const state = base64url(randomBytes(24));
  const authorizeUrl =
    `${CODEX_AUTHORIZE_URL}?` +
    new URLSearchParams({
      response_type: "code",
      client_id: CODEX_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "openid profile email offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: "fusion",
    }).toString();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Login timed out"));
    }, timeoutMs);

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${OAUTH_PORT}`);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      if (!code || returnedState !== state) {
        res.writeHead(400).end("Invalid login callback (state mismatch).");
        clearTimeout(timer);
        server.close();
        reject(new Error("Invalid OAuth callback (state mismatch or missing code)"));
        return;
      }
      exchangeCode(code, verifier)
        .then((tokens) => {
          const accountId = extractAccountIdFromClaims(decodeJwtPayload(tokens.id_token));
          const path = codexAuthFile();
          const file: CodexAuthFile = {
            last_refresh: new Date().toISOString(),
            OPENAI_API_KEY: null,
            tokens: {
              access_token: tokens.access_token,
              id_token: tokens.id_token,
              refresh_token: tokens.refresh_token,
              ...(accountId ? { account_id: accountId } : {}),
            },
          };
          writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
          res
            .writeHead(200, { "Content-Type": "text/html" })
            .end(
              "<html><body><h2>Fusion login complete.</h2>You can close this tab and return to the terminal.</body></html>",
            );
          clearTimeout(timer);
          server.close();
          resolve({ accountId, path });
        })
        .catch((err: unknown) => {
          res.writeHead(500).end("Token exchange failed.");
          clearTimeout(timer);
          server.close();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    server.listen(OAUTH_PORT, "127.0.0.1", () => {
      process.stdout.write(
        `\nOpen this URL to sign in (browser should open automatically):\n\n${authorizeUrl}\n\n`,
      );
      openBrowser(authorizeUrl);
    });
  });
}
