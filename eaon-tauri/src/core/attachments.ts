// Attachments — the port of REF attachments.ts (itself the Mac
// AttachmentStore + ImagePayloadBuilder). Images are normalized on import
// (canvas → PNG, long edge capped) so a picked oversized photo neither blows
// a provider's payload limit nor balloons token cost; non-image files ride
// along as a "[Attached: …]" note. Vision capability is decided by the
// caller (ModelEntry.supportsVision) instead of REF's model-id heuristic —
// the catalog already knows.

import { readAttachment, saveAttachment } from "./ipc";
import type { ContentPart, MessageAttachment } from "./types";
import { uid } from "./utils";

/** Anthropic's own docs note no vision-quality benefit past this on the
 *  long edge — the same provider-agnostic cap the Mac app uses. */
const MAX_IMAGE_DIMENSION = 1568;

/** Formats every webview here can decode onto a canvas. Anything else
 *  (e.g. HEIC on Windows WebView2) is stored byte-for-byte instead. */
const CANVAS_DECODABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** File → base64 (no data: prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(",");
      resolve(comma === -1 ? url : url.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Decodes, caps to MAX_IMAGE_DIMENSION on the long edge, re-encodes as
 *  PNG. Null when the webview can't decode it after all — the caller then
 *  stores the raw bytes with their real mime (REF normalizedPngBase64). */
async function normalizedPngBase64(file: File): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = longEdge > MAX_IMAGE_DIMENSION ? MAX_IMAGE_DIMENSION / longEdge : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/png");
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  } finally {
    bitmap.close();
  }
}

/** Imports one picked/pasted/dropped file into the attachments store:
 *  decodable images are normalized to capped PNG; everything else is stored
 *  byte-for-byte with its real mime recorded. */
export async function importFile(file: File): Promise<MessageAttachment> {
  const isImage = file.type.startsWith("image/");
  if (isImage && CANVAS_DECODABLE.has(file.type)) {
    const png = await normalizedPngBase64(file);
    if (png) {
      const baseName = file.name.replace(/\.[a-z0-9]+$/i, "");
      const stored = await saveAttachment(png, (baseName || "image") + ".png");
      return {
        id: uid(),
        fileName: file.name || "Pasted image.png",
        kind: "image",
        storedFileName: stored,
        mimeType: "image/png",
      };
    }
    // Decode failed despite the mime claim — fall through to raw storage;
    // vision providers accept png/jpeg/webp/gif bytes directly anyway.
  }
  const raw = await fileToBase64(file);
  const fallbackName = isImage ? "image" : "file";
  const stored = await saveAttachment(raw, file.name || fallbackName);
  return {
    id: uid(),
    fileName: file.name || fallbackName,
    kind: isImage ? "image" : "file",
    storedFileName: stored,
    mimeType: file.type || (isImage ? "image/png" : "application/octet-stream"),
  };
}

/** Builds the request content for one message: real image parts for a vision
 *  model, the "[Attached: …]" fallback note for everything else — the exact
 *  split REF buildContent / Mac historyTurn makes. Non-image files always
 *  ride as the note; an unreadable image degrades to the note too. */
export async function buildContent(
  text: string,
  attachments: MessageAttachment[],
  supportsVision: boolean,
): Promise<string | ContentPart[]> {
  if (!attachments.length) return text;

  const parts: ContentPart[] = [];
  const unsent: MessageAttachment[] = [];

  for (const attachment of attachments) {
    if (supportsVision && attachment.kind === "image") {
      try {
        const base64 = await readAttachment(attachment.storedFileName);
        parts.push({ type: "image_url", image_url: { url: `data:${attachment.mimeType};base64,${base64}` } });
      } catch {
        unsent.push(attachment);
      }
    } else {
      unsent.push(attachment);
    }
  }

  let body = text;
  if (unsent.length) {
    const note = `[Attached: ${unsent.map((a) => a.fileName).join(", ")}]`;
    body = body ? `${body}\n\n${note}` : note;
  }

  if (!parts.length) return body;
  const out: ContentPart[] = [];
  if (body) out.push({ type: "text", text: body });
  return [...out, ...parts];
}
