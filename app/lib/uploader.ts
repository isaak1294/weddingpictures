// Client-side upload engine: compress images in the browser, then upload each
// file as its own small request with real progress events.
//
// Why compress? The app is hosted on Vercel, which caps request bodies at
// ~4.5 MB. A full-resolution phone photo often exceeds that, so it could never
// reach /api/upload. Downscaling to ~3000 px at high quality brings virtually
// every photo well under the cap and makes uploads far faster on mobile data.

/** Stay comfortably under Vercel's ~4.5 MB body cap (leaves room for multipart overhead). */
export const MAX_UPLOAD_BYTES = 4.3 * 1024 * 1024;

const DEFAULTS = {
  maxEdge: 3000, // longest side, in pixels
  quality: 0.9, // JPEG quality
  targetBytes: 3.6 * 1024 * 1024, // shrink until the encoded image is under this
};

function renameToJpg(name: string): string {
  return name.replace(/\.[^.]+$/, "") + ".jpg";
}

/**
 * Downscale/re-encode an image to fit under the size cap. Returns the original
 * file unchanged for non-images, or when the browser can't decode it (e.g. HEIC
 * on Android) — the caller then decides whether it still fits.
 */
export async function compressImage(
  file: File,
  opts: Partial<typeof DEFAULTS> = {}
): Promise<File> {
  const { maxEdge, quality, targetBytes } = { ...DEFAULTS, ...opts };

  if (!file.type.startsWith("image/")) return file;

  // Already small and in a universally-viewable format — keep the original bytes.
  if (
    file.size <= targetBytes &&
    /^image\/(jpeg|png|webp)$/.test(file.type)
  ) {
    return file;
  }

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
    const longest = Math.max(width, height);
    let scale = longest > maxEdge ? maxEdge / longest : 1;

    for (let attempt = 0; attempt < 6; attempt++) {
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
      if (!blob) return file;

      const smallEnough = blob.size <= targetBytes;
      const giveUp = scale <= 0.3 && attempt >= 1;
      if (smallEnough || giveUp) {
        return new File([blob], renameToJpg(file.name), {
          type: "image/jpeg",
          lastModified: file.lastModified,
        });
      }
      scale *= 0.8; // still too big — shrink and try again
    }
    return file;
  } finally {
    bitmap.close();
  }
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
