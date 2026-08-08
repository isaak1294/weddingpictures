// Client-side upload engine: upload each file as its own small request with
// real progress events, compressing an image ONLY when its original size would
// exceed the request-body cap.
//
// Why the cap matters: the app is hosted on Vercel, which rejects request
// bodies over ~4.5 MB, so a file larger than that could never reach
// /api/upload. Photos that already fit are uploaded byte-for-byte untouched
// (full resolution, original format, EXIF intact). Only oversized ones are
// shrunk — and only as much as needed to squeeze under the cap.

/** Stay comfortably under Vercel's ~4.5 MB body cap (leaves room for multipart overhead). */
export const MAX_UPLOAD_BYTES = 4.3 * 1024 * 1024;

/**
 * Ceiling for the direct-to-Google path. Apps Script accepts a POST body of a
 * few tens of MB; base64 inflates the file ~1.33×, so we cap the raw file well
 * below that. Covers every photo and short phone videos. Truly large videos
 * exceed Google's own limit and must be shared another way.
 */
export const DIRECT_MAX_BYTES = 30 * 1024 * 1024;

/** When we must compress, aim just under the cap to preserve as much quality as possible. */
const COMPRESS_TARGET_BYTES = 4.0 * 1024 * 1024;

/** True only for images that are too large to upload as-is. */
export function needsCompression(file: File): boolean {
  return file.type.startsWith("image/") && file.size > MAX_UPLOAD_BYTES;
}

function renameToJpg(name: string): string {
  return name.replace(/\.[^.]+$/, "") + ".jpg";
}

/**
 * Shrink an over-cap image just enough to fit, trying to keep full resolution
 * and only stepping down quality/dimensions as needed. Returns the original
 * file unchanged when it already fits, isn't an image, or can't be decoded
 * (e.g. HEIC on Android) — the caller then flags anything still too large.
 */
export async function compressImage(
  file: File,
  targetBytes: number = COMPRESS_TARGET_BYTES
): Promise<File> {
  if (!needsCompression(file)) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    } as ImageBitmapOptions);
  } catch {
    return file; // undecodable — upload as-is (may be flagged too-large later)
  }

  try {
    const { width, height } = bitmap;

    // Try highest fidelity first, easing off only when still over target:
    // keep full resolution and drop quality, then downscale as a last resort.
    const steps: Array<{ scale: number; quality: number }> = [
      { scale: 1, quality: 0.92 },
      { scale: 1, quality: 0.85 },
      { scale: 1, quality: 0.8 },
    ];
    for (let scale = 0.85; scale >= 0.3; scale *= 0.85) {
      steps.push({ scale, quality: 0.82 });
    }

    let last: Blob | null = null;
    for (const { scale, quality } of steps) {
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return file;
      ctx.drawImage(bitmap, 0, 0, w, h);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality)
      );
      if (!blob) return last ? toFile(last, file) : file;
      last = blob;
      if (blob.size <= targetBytes) return toFile(blob, file);
    }

    // Couldn't get under target even at the smallest step — send the smallest
    // we produced; the caller flags it if it's still over the hard cap.
    return last ? toFile(last, file) : file;
  } finally {
    bitmap.close();
  }
}

function toFile(blob: Blob, original: File): File {
  return new File([blob], renameToJpg(original.name), {
    type: "image/jpeg",
    lastModified: original.lastModified,
  });
}

export type UploadHandle = { promise: Promise<void>; abort: () => void };

/**
 * Upload a single file to /api/upload with progress callbacks. Uses XHR because
 * fetch() cannot report upload progress. Resolves on success; rejects with an
 * Error (message safe to show the user) or a DOMException("AbortError").
 */
export function uploadFile(
  file: File,
  guestName: string,
  onProgress: (fraction: number) => void
): UploadHandle {
  const xhr = new XMLHttpRequest();

  const promise = new Promise<void>((resolve, reject) => {
    xhr.open("POST", "/api/upload");
    xhr.timeout = 180_000;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };

    xhr.onload = () => {
      let res: { ok?: boolean; error?: string } = {};
      try {
        res = JSON.parse(xhr.responseText);
      } catch {
        return reject(new Error("Unexpected response from the server."));
      }
      if (xhr.status >= 200 && xhr.status < 300 && res.ok) {
        onProgress(1);
        resolve();
      } else {
        reject(new Error(res.error || `Upload failed (${xhr.status}).`));
      }
    };

    xhr.onerror = () => reject(new Error("Network error — check your connection."));
    xhr.ontimeout = () => reject(new Error("Upload timed out."));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));

    const form = new FormData();
    form.append("name", guestName);
    form.append("files", file);
    xhr.send(form);
  });

  return { promise, abort: () => xhr.abort() };
}

// --- Direct-to-Google path (bypasses Vercel's body-size cap) -----------------

type Ticket = { ticket: string; url: string; exp: number };
let cachedTicket: Ticket | null = null;
let ticketInFlight: Promise<Ticket> | null = null;

/**
 * Fetch a short-lived signed upload ticket (and the Apps Script URL) from our
 * own server. Cached and shared across concurrent uploads; refreshed before it
 * expires. The signing secret never reaches the browser.
 */
export async function getTicket(): Promise<{ ticket: string; url: string }> {
  const now = Date.now() / 1000;
  if (cachedTicket && cachedTicket.exp - now > 120) {
    return { ticket: cachedTicket.ticket, url: cachedTicket.url };
  }
  if (!ticketInFlight) {
    ticketInFlight = (async () => {
      try {
        const res = await fetch("/api/upload-ticket", { method: "POST" });
        const data = await res.json();
        if (!res.ok || !data.ok || !data.ticket || !data.url) {
          throw new Error(data.error || "Could not prepare a direct upload.");
        }
        cachedTicket = { ticket: data.ticket, url: data.url, exp: data.exp };
        return cachedTicket;
      } finally {
        ticketInFlight = null;
      }
    })();
  }
  const t = await ticketInFlight;
  return { ticket: t.ticket, url: t.url };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return reject(new Error("Could not read file."));
      resolve(result.slice(result.indexOf(",") + 1)); // strip "data:...;base64,"
    };
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

/**
 * Upload a single file straight to the Apps Script Web App, bypassing our
 * server (and therefore Vercel's body cap). The body is sent as text/plain so
 * the browser skips the CORS preflight that Apps Script can't answer.
 */
export function uploadDirect(
  file: File,
  guestName: string,
  ticket: string,
  url: string,
  onProgress: (fraction: number) => void
): UploadHandle {
  const xhr = new XMLHttpRequest();
  let aborted = false;

  const promise = (async () => {
    const base64 = await fileToBase64(file);
    if (aborted) throw new DOMException("Aborted", "AbortError");

    return new Promise<void>((resolve, reject) => {
      xhr.open("POST", url);
      xhr.timeout = 300_000;

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };

      xhr.onload = () => {
        let res: { ok?: boolean; error?: string } = {};
        try {
          res = JSON.parse(xhr.responseText);
        } catch {
          return reject(new Error("Unexpected response from Google Drive."));
        }
        if (xhr.status >= 200 && xhr.status < 300 && res.ok) {
          onProgress(1);
          resolve();
        } else {
          reject(new Error(res.error || `Upload failed (${xhr.status}).`));
        }
      };

      xhr.onerror = () =>
        reject(new Error("Could not reach Google Drive — check your connection."));
      xhr.ontimeout = () => reject(new Error("Upload timed out."));
      xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));

      // No Content-Type header on purpose: the default text/plain is a
      // CORS-safelisted type, so no preflight is sent to Apps Script.
      xhr.send(
        JSON.stringify({
          ticket,
          name: guestName,
          files: [
            {
              name: file.name || "photo",
              type: file.type || "application/octet-stream",
              data: base64,
            },
          ],
        })
      );
    });
  })();

  return {
    promise,
    abort: () => {
      aborted = true;
      xhr.abort();
    },
  };
}
