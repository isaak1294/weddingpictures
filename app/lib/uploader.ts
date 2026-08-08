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
