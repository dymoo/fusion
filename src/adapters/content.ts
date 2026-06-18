import type { ContentPart } from "../neutral/types.js";

/** Parse a `data:` URI into media type + base64 payload. */
export function parseDataUri(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  const mediaType = match[1] ?? "application/octet-stream";
  const isBase64 = match[2] === ";base64";
  const payload = match[3] ?? "";
  return {
    mediaType,
    data: isBase64 ? payload : Buffer.from(decodeURIComponent(payload)).toString("base64"),
  };
}

/** Render a neutral image part as a URL suitable for OpenAI `image_url`. */
export function imagePartToUrl(part: Extract<ContentPart, { kind: "image" }>): string {
  if (part.source.type === "url") return part.source.url;
  return `data:${part.mediaType};base64,${part.source.data}`;
}
