import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getString } from "../adapters/json.js";

/** Read the package version from the installed package.json (dist/util → ../../). */
export function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../../package.json", "../package.json"]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(here, rel), "utf8"));
      const version = getString(parsed, "version");
      if (version) return version;
    } catch {
      // try next
    }
  }
  return "0.0.0";
}
