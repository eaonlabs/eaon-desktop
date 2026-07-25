// One attachment, three renderings: a 64px composer thumbnail (removable),
// a larger in-bubble thumbnail, or a full-size generated image with a save
// button. Image bytes come from the Rust attachments store; decoded object
// URLs are cached module-level so re-renders never re-read the file.

import { useEffect, useState } from "react";
import { Download, FileText, X } from "lucide-react";
import { readAttachment } from "../../core/ipc";
import type { MessageAttachment } from "../../core/types";

/** storedFileName → object-URL promise. Never revoked: attachments are tiny
 *  relative to the webview and reappear constantly while scrolling. */
const objectUrlCache = new Map<string, Promise<string>>();

function attachmentObjectUrl(attachment: MessageAttachment): Promise<string> {
  let cached = objectUrlCache.get(attachment.storedFileName);
  if (!cached) {
    cached = readAttachment(attachment.storedFileName).then((base64) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], {
        type: attachment.mimeType || "application/octet-stream",
      });
      return URL.createObjectURL(blob);
    });
    objectUrlCache.set(attachment.storedFileName, cached);
  }
  return cached;
}

/** Saves via a temporary anchor — the webview's own download path, no
 *  dialog plumbing needed. */
function saveFromUrl(url: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
}

export interface AttachmentThumbProps {
  attachment: MessageAttachment;
  /** "composer" = 64px pending chip, "bubble" = in-message thumbnail,
   *  "generated" = large image-model output with a save button. */
  variant?: "composer" | "bubble" | "generated";
  /** Present only on composer chips — shows the remove button. */
  onRemove?: () => void;
}

export default function AttachmentThumb({
  attachment,
  variant = "bubble",
  onRemove,
}: AttachmentThumbProps) {
  const isImage = attachment.kind === "image";
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isImage) return;
    let alive = true;
    attachmentObjectUrl(attachment)
      .then((objectUrl) => {
        if (alive) setUrl(objectUrl);
      })
      .catch(() => {
        // A missing/corrupt stored file just leaves the placeholder.
      });
    return () => {
      alive = false;
    };
  }, [attachment, isImage]);

  if (!isImage) {
    return (
      <span className={`att-file att-file-${variant}`} title={attachment.fileName}>
        <FileText size={13} aria-hidden />
        <span className="att-file-name">{attachment.fileName}</span>
        {onRemove && (
          <button
            className="att-remove att-remove-file"
            title="Remove attachment"
            aria-label={`Remove ${attachment.fileName}`}
            onClick={onRemove}
          >
            <X size={10} strokeWidth={2.6} />
          </button>
        )}
      </span>
    );
  }

  if (variant === "generated") {
    return (
      <figure className="att-generated">
        {url ? (
          <img src={url} alt={attachment.fileName} />
        ) : (
          <div className="att-loading att-loading-generated" />
        )}
        {url && (
          <button
            className="att-download"
            title="Save image"
            aria-label={`Save ${attachment.fileName}`}
            onClick={() => saveFromUrl(url, attachment.fileName)}
          >
            <Download size={14} />
          </button>
        )}
      </figure>
    );
  }

  return (
    <span className={`att-image att-image-${variant}`}>
      {url ? (
        <img src={url} alt={attachment.fileName} title={attachment.fileName} />
      ) : (
        <span className="att-loading" />
      )}
      {onRemove && (
        <button
          className="att-remove"
          title="Remove attachment"
          aria-label={`Remove ${attachment.fileName}`}
          onClick={onRemove}
        >
          <X size={10} strokeWidth={2.6} />
        </button>
      )}
    </span>
  );
}
