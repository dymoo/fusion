#!/usr/bin/env node
/**
 * Fusion CLI.
 *
 *   fusion start [--port N] [--config path] [--host h]   start the background daemon
 *   fusion stop                                          stop the daemon
 *   fusion status                                        report daemon status
 *   fusion restart [--port N] [--config path]            restart the daemon
 *   fusion logs [--lines N] [--follow]                   tail the daemon log
 *   fusion run [--port N] [--config path] [--host h]     run in the foreground
 *   fusion auth login                                    OpenAI Codex/ChatGPT login (PKCE)
 *   fusion --version | --help
 */
import { parseArgs } from "node:util";

import { runLogin } from "./auth/oauth-login.js";
import { loadConfig } from "./config/load.js";
import {
  restartDaemon,
  registerForeground,
  startDaemon,
  statusDaemon,
  stopDaemon,
} from "./daemon/index.js";
import { tailLogs } from "./daemon/logs.js";
import { clearPidFiles } from "./daemon/pidfile.js";
import { startServer } from "./server/http.js";
import { packageVersion } from "./util/version.js";

const HELP = `fusion — local OpenAI/Anthropic-compatible fusion model provider

Usage:
  fusion start [--port N] [--config FILE] [--host H]   Start the background daemon
  fusion stop                                          Stop the daemon
  fusion status                                        Show daemon status
  fusion restart [--port N] [--config FILE]            Restart the daemon
  fusion logs [--lines N] [--follow]                   Tail the daemon log
  fusion run [--port N] [--config FILE] [--host H]     Run in the foreground
  fusion auth login                                    Sign in to OpenAI Codex/ChatGPT
  fusion --version                                     Print version
  fusion --help                                        Show this help
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      port: { type: "string" },
      config: { type: "string" },
      host: { type: "string" },
      lines: { type: "string" },
      follow: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  const command = positionals[0];
  if (values.help || !command || command === "help") {
    process.stdout.write(HELP);
    return command ? 0 : 1;
  }

  const portOpt = values.port ? Number(values.port) : undefined;
  const configPath = values.config;

  switch (command) {
    case "auth": {
      if (positionals[1] !== "login") {
        process.stderr.write("Usage: fusion auth login\n");
        return 1;
      }
      const { accountId, path } = await runLogin();
      process.stdout.write(
        `Logged in. Credentials saved to ${path}${accountId ? ` (account ${accountId})` : ""}\n`,
      );
      return 0;
    }

    case "stop": {
      const r = await stopDaemon();
      process.stdout.write(`${r.message}\n`);
      return r.ok ? 0 : 1;
    }

    case "logs": {
      const lines = values.lines ? Number(values.lines) : 50;
      await tailLogs({ lines, follow: values.follow ?? false });
      return 0;
    }

    case "start": {
      const { config } = loadConfig(configPath);
      if (values.host) config.server.host = values.host;
      const port = portOpt ?? config.server.port;
      const r = await startDaemon(config, port, configPath);
      process.stdout.write(`${r.message}\n`);
      return r.ok ? 0 : 1;
    }

    case "restart": {
      const { config } = loadConfig(configPath);
      if (values.host) config.server.host = values.host;
      const port = portOpt ?? config.server.port;
      const r = await restartDaemon(config, port, configPath);
      process.stdout.write(`${r.message}\n`);
      return r.ok ? 0 : 1;
    }

    case "status": {
      const { config } = loadConfig(configPath);
      const r = await statusDaemon(config);
      process.stdout.write(`${r.message}\n`);
      return r.ok ? 0 : 1;
    }

    case "run": {
      const { config } = loadConfig(configPath);
      if (values.host) config.server.host = values.host;
      const port = portOpt ?? config.server.port;
      const running = await startServer(config, port);
      registerForeground(running.port);
      const shutdown = (): void => {
        running.app.shutdown();
        running.server.close();
        clearPidFiles();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return new Promise<number>(() => {
        /* keep the process alive until a signal arrives */
      });
    }

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
