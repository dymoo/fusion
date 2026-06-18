import { createReadStream, statSync, watch } from "node:fs";

import { logFile } from "../config/paths.js";

async function readTail(path: string, lines: number): Promise<{ text: string; size: number }> {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { text: "", size: 0 };
  }
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    createReadStream(path, { encoding: "utf8" })
      .on("data", (c) => chunks.push(Buffer.from(c)))
      .on("end", resolve)
      .on("error", reject);
  });
  const all = Buffer.concat(chunks).toString("utf8").split("\n");
  const tail = all.slice(Math.max(0, all.length - lines - 1)).join("\n");
  return { text: tail, size };
}

/** Print the tail of the log file; optionally follow appended output. */
export async function tailLogs(opts: { lines: number; follow: boolean }): Promise<void> {
  const path = logFile();
  const { text, size } = await readTail(path, opts.lines);
  if (text) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  if (!opts.follow) return;

  let position = size;
  await new Promise<void>(() => {
    const watcher = watch(path, { persistent: true }, () => {
      let current = 0;
      try {
        current = statSync(path).size;
      } catch {
        return;
      }
      if (current <= position) {
        position = current;
        return;
      }
      createReadStream(path, { start: position, end: current - 1, encoding: "utf8" })
        .on("data", (c) => process.stdout.write(c))
        .on("end", () => {
          position = current;
        });
    });
    process.on("SIGINT", () => {
      watcher.close();
      process.exit(0);
    });
  });
}
