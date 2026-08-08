"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  compressImage,
  uploadFile,
  MAX_UPLOAD_BYTES,
  type UploadHandle,
} from "./lib/uploader";

type ItemStatus =
  | "pending" // chosen, not started
  | "queued" // waiting for a worker
  | "compressing"
  | "uploading"
  | "done"
  | "error"
  | "canceled";

type Item = {
  id: string;
  file: File;
  status: ItemStatus;
  progress: number; // 0..1
  error?: string;
};

const CONCURRENCY = 3;
const MAX_ATTEMPTS = 3;

const isActive = (s: ItemStatus) =>
  s === "queued" || s === "compressing" || s === "uploading";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function Home() {
  const [name, setName] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Refs mirror the latest values so the async worker pool can read them
  // without stale closures.
  const itemsRef = useRef<Item[]>([]);
  const nameRef = useRef("");
  const activeCount = useRef(0);
  const handles = useRef<Map<string, UploadHandle>>(new Map());
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const pumpRef = useRef<() => void>(() => {});

  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  const uploading = items.some((it) => isActive(it.status));
  const doneCount = items.filter((it) => it.status === "done").length;
  const errorCount = items.filter((it) => it.status === "error").length;
  const total = items.length;

  // --- item mutation helpers: keep ref (source of truth) and state in sync ---
  const patchItem = useCallback((id: string, patch: Partial<Item>) => {
    itemsRef.current = itemsRef.current.map((it) =>
      it.id === id ? { ...it, ...patch } : it
    );
    setItems(itemsRef.current);
  }, []);

  const setAllItems = useCallback((next: Item[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  // --- screen wake lock (best-effort; not supported everywhere) ---
  const acquireWakeLock = useCallback(async () => {
    try {
      if ("wakeLock" in navigator && !wakeLock.current) {
        wakeLock.current = await navigator.wakeLock.request("screen");
        wakeLock.current.addEventListener("release", () => {
          wakeLock.current = null;
        });
      }
    } catch {
      /* ignore — wake lock is a nice-to-have */
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    wakeLock.current?.release().catch(() => {});
    wakeLock.current = null;
  }, []);

  // Re-acquire the wake lock if the page comes back to the foreground mid-upload.
  useEffect(() => {
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        itemsRef.current.some((it) => isActive(it.status))
      ) {
        acquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [acquireWakeLock]);

  // Warn before leaving while uploads are in flight.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (itemsRef.current.some((it) => isActive(it.status))) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // --- the worker: compress then upload one file, with retries ---
  const processItem = useCallback(
    async (id: string) => {
      const current = itemsRef.current.find((it) => it.id === id);
      if (!current) return;

      let toUpload = current.file;
      if (current.file.type.startsWith("image/")) {
        patchItem(id, { status: "compressing", progress: 0 });
        try {
          toUpload = await compressImage(current.file);
        } catch {
          toUpload = current.file; // fall back to the original
        }
      }

      if (toUpload.size > MAX_UPLOAD_BYTES) {
        patchItem(id, {
          status: "error",
          error: `Too large to upload here (${formatBytes(
            toUpload.size
          )}). Videos and huge files exceed the server limit.`,
        });
        return;
      }

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        patchItem(id, { status: "uploading", progress: 0, error: undefined });
        const handle = uploadFile(toUpload, nameRef.current, (frac) =>
          patchItem(id, { progress: frac })
        );
        handles.current.set(id, handle);
        try {
          await handle.promise;
          handles.current.delete(id);
          patchItem(id, { status: "done", progress: 1 });
          return;
        } catch (err) {
          handles.current.delete(id);
          if (err instanceof DOMException && err.name === "AbortError") {
            patchItem(id, { status: "canceled", progress: 0 });
            return;
          }
          if (attempt === MAX_ATTEMPTS) {
            patchItem(id, {
              status: "error",
              error: err instanceof Error ? err.message : "Upload failed.",
            });
            return;
          }
          // brief backoff before retrying
          await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
    },
    [patchItem]
  );

  // --- the pool: keep up to CONCURRENCY items processing ---
  const pump = useCallback(() => {
    while (activeCount.current < CONCURRENCY) {
      const next = itemsRef.current.find((it) => it.status === "queued");
      if (!next) break;
      activeCount.current++;
      // mark synchronously so the next find() won't pick it again
      patchItem(next.id, { status: "compressing", progress: 0 });
      processItem(next.id).finally(() => {
        activeCount.current--;
        pumpRef.current();
      });
    }
    if (
      activeCount.current === 0 &&
      !itemsRef.current.some((it) => isActive(it.status))
    ) {
      releaseWakeLock();
    }
  }, [patchItem, processItem, releaseWakeLock]);

  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  // --- file selection ---
  const addFiles = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      const currentlyUploading = itemsRef.current.some((it) =>
        isActive(it.status)
      );
      const added: Item[] = Array.from(list).map((file) => ({
        id: crypto.randomUUID(),
        file,
        // If a batch is already running, new picks join the queue and go.
        status: currentlyUploading ? "queued" : "pending",
        progress: 0,
      }));
      setAllItems([...itemsRef.current, ...added]);
      if (currentlyUploading) pump();
    },
    [pump, setAllItems]
  );

  const removeItem = useCallback(
    (id: string) => {
      handles.current.get(id)?.abort();
      handles.current.delete(id);
      setAllItems(itemsRef.current.filter((it) => it.id !== id));
    },
    [setAllItems]
  );

  const startUpload = useCallback(() => {
    const next = itemsRef.current.map((it) =>
      it.status === "pending" ? { ...it, status: "queued" as const } : it
    );
    setAllItems(next);
    acquireWakeLock();
    pump();
  }, [acquireWakeLock, pump, setAllItems]);

  const retryFailed = useCallback(() => {
    const next = itemsRef.current.map((it) =>
      it.status === "error" || it.status === "canceled"
        ? { ...it, status: "queued" as const, progress: 0, error: undefined }
        : it
    );
    setAllItems(next);
    acquireWakeLock();
    pump();
  }, [acquireWakeLock, pump, setAllItems]);

  const cancelAll = useCallback(() => {
    handles.current.forEach((h) => h.abort());
    const next = itemsRef.current.map((it) =>
      it.status === "queued" ? { ...it, status: "pending" as const } : it
    );
    setAllItems(next);
  }, [setAllItems]);

  const clearFinished = useCallback(() => {
    setAllItems(itemsRef.current.filter((it) => it.status !== "done"));
  }, [setAllItems]);

  const pendingCount = items.filter((it) => it.status === "pending").length;
  const allDone = total > 0 && !uploading && doneCount + errorCount === total;

  return (
    <main className="flex flex-1 items-center justify-center px-5 py-12">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="text-center mb-8">
          <p className="text-sage-deep uppercase tracking-[0.25em] text-xs font-medium mb-3">
            With love &amp; thanks
          </p>
          <h1 className="font-serif text-navy text-5xl sm:text-6xl leading-tight">
            Share Your Photos
          </h1>
          <p className="mt-4 text-navy/70 leading-relaxed">
            Help us relive the day! Add the photos you captured at our wedding —
            you can pick 50 or more at once and they&apos;ll upload straight to
            our album.
          </p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-sm ring-1 ring-navy/5 p-6 sm:p-8">
          <label className="block mb-5">
            <span className="block text-sm font-medium text-navy mb-1.5">
              Your name{" "}
              <span className="text-navy/40 font-normal">(optional)</span>
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Aunt Marie"
              className="w-full rounded-lg border border-navy/15 bg-cream/40 px-3.5 py-2.5 text-navy placeholder:text-navy/35 outline-none focus:border-sage focus:ring-2 focus:ring-sage/30 transition"
            />
          </label>

          {/* Dropzone / file picker */}
          <label
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              addFiles(e.dataTransfer.files);
            }}
            className="group flex flex-col items-center justify-center text-center rounded-xl border-2 border-dashed border-sage/50 bg-sage-soft/30 hover:bg-sage-soft/60 px-6 py-10 cursor-pointer transition"
          >
            <svg
              className="w-9 h-9 text-sage-deep mb-3"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span className="text-navy font-medium">Tap to choose photos</span>
            <span className="text-navy/50 text-sm mt-1">
              or drag &amp; drop them here
            </span>
            <input
              ref={inputRef}
              type="file"
              accept="image/*,video/*"
              multiple
              onChange={(e) => {
                addFiles(e.target.files);
                if (inputRef.current) inputRef.current.value = "";
              }}
              className="hidden"
            />
          </label>

          {/* Overall progress */}
          {total > 0 && (
            <div className="mt-5">
              <div className="flex items-center justify-between text-sm text-navy/70 mb-1.5">
                <span>
                  {uploading
                    ? `Uploading… ${doneCount} of ${total} done`
                    : allDone
                    ? errorCount > 0
                      ? `${doneCount} uploaded, ${errorCount} need attention`
                      : `All ${doneCount} uploaded 🎉`
                    : `${total} photo${total === 1 ? "" : "s"} ready`}
                </span>
                {(doneCount > 0 || errorCount > 0) && (
                  <span className="tabular-nums">
                    {Math.round(((doneCount + errorCount) / total) * 100)}%
                  </span>
                )}
              </div>
              <div className="h-2 w-full rounded-full bg-cream overflow-hidden">
                <div
                  className="h-full bg-sage-deep transition-[width] duration-300"
                  style={{
                    width: `${((doneCount + errorCount) / total) * 100}%`,
                  }}
                />
              </div>
            </div>
          )}

          {/* Keep-open reminder while uploading */}
          {uploading && (
            <p className="mt-4 rounded-lg bg-sage-soft/50 px-3.5 py-2.5 text-sm text-navy/75">
              Keep this tab open while photos upload. You can dim your screen,
              but switching apps may pause it.
            </p>
          )}

          {/* Per-file list */}
          {items.length > 0 && (
            <ul className="mt-4 space-y-2 max-h-80 overflow-y-auto pr-1">
              {items.map((it) => (
                <li
                  key={it.id}
                  className="rounded-lg bg-cream/60 px-3 py-2 text-sm"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-navy">{it.file.name}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <StatusBadge item={it} />
                      {!isActive(it.status) && (
                        <button
                          type="button"
                          onClick={() => removeItem(it.id)}
                          className="text-navy/40 hover:text-navy"
                          aria-label={`Remove ${it.file.name}`}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>

                  {(it.status === "uploading" ||
                    it.status === "compressing" ||
                    it.status === "queued") && (
                    <div className="mt-1.5 h-1.5 w-full rounded-full bg-navy/10 overflow-hidden">
                      <div
                        className={`h-full transition-[width] duration-200 ${
                          it.status === "uploading"
                            ? "bg-sage-deep"
                            : "bg-sage/60 animate-pulse w-1/3"
                        }`}
                        style={
                          it.status === "uploading"
                            ? { width: `${Math.round(it.progress * 100)}%` }
                            : undefined
                        }
                      />
                    </div>
                  )}

                  {it.status === "error" && it.error && (
                    <p className="mt-1 text-xs text-red-600">{it.error}</p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* Actions */}
          <div className="mt-6 space-y-2.5">
            {(pendingCount > 0 || (total === 0 && !uploading)) && (
              <button
                type="button"
                onClick={startUpload}
                disabled={total === 0}
                className="w-full rounded-lg bg-navy hover:bg-navy-deep disabled:opacity-60 disabled:cursor-not-allowed text-cream font-medium py-3 transition"
              >
                {total > 0
                  ? `Upload ${total} photo${total === 1 ? "" : "s"}`
                  : "Upload"}
              </button>
            )}

            {uploading && (
              <button
                type="button"
                onClick={cancelAll}
                className="w-full rounded-lg border border-navy/15 text-navy/70 hover:bg-cream font-medium py-3 transition"
              >
                Cancel remaining
              </button>
            )}

            {!uploading && (errorCount > 0) && (
              <button
                type="button"
                onClick={retryFailed}
                className="w-full rounded-lg bg-sage-deep hover:bg-sage text-white font-medium py-3 transition"
              >
                Retry {errorCount} failed
              </button>
            )}

            {!uploading && doneCount > 0 && (
              <button
                type="button"
                onClick={clearFinished}
                className="w-full rounded-lg text-navy/50 hover:text-navy text-sm py-2 transition"
              >
                Clear {doneCount} uploaded from the list
              </button>
            )}
          </div>
        </div>

        <p className="text-center text-navy/40 text-xs mt-6">
          Photos are gently resized for faster uploading and shared privately
          with the couple.
        </p>
      </div>
    </main>
  );
}

function StatusBadge({ item }: { item: Item }) {
  switch (item.status) {
    case "pending":
      return <span className="text-navy/40 text-xs">ready</span>;
    case "queued":
      return <span className="text-navy/50 text-xs">waiting…</span>;
    case "compressing":
      return <span className="text-sage-deep text-xs">preparing…</span>;
    case "uploading":
      return (
        <span className="text-sage-deep text-xs tabular-nums">
          {Math.round(item.progress * 100)}%
        </span>
      );
    case "done":
      return <span className="text-sage-deep text-xs">✓ done</span>;
    case "canceled":
      return <span className="text-navy/40 text-xs">canceled</span>;
    case "error":
      return <span className="text-red-600 text-xs">failed</span>;
  }
}
