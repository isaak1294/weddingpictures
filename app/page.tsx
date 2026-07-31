"use client";

import { useState, useRef } from "react";

type Status = "idle" | "uploading" | "done" | "error";

export default function Home() {
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((prev) => [...prev, ...Array.from(list)]);
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (files.length === 0) {
      setStatus("error");
      setMessage("Please choose at least one photo to share.");
      return;
    }

    setStatus("uploading");
    setMessage("");

    const data = new FormData();
    data.append("name", name);
    files.forEach((file) => data.append("files", file));

    try {
      const res = await fetch("/api/upload", { method: "POST", body: data });
      const result = await res.json();
      if (!res.ok || !result.ok) {
        throw new Error(result.error || "Upload failed. Please try again.");
      }
      setStatus("done");
      setMessage(
        `Thank you${name ? `, ${name}` : ""}! ${result.count} photo${
          result.count === 1 ? "" : "s"
        } uploaded.`
      );
      setFiles([]);
      setName("");
      if (inputRef.current) inputRef.current.value = "";
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Something went wrong.");
    }
  };

  return (
    <main className="flex flex-1 items-center justify-center px-5 py-12">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="text-center mb-8">
          <p className="text-sage-deep uppercase tracking-[0.25em] text-xs font-medium mb-3">
            With love & thanks
          </p>
          <h1 className="font-serif text-navy text-5xl sm:text-6xl leading-tight">
            Share Your Photos
          </h1>
          <p className="mt-4 text-navy/70 leading-relaxed">
            Help us relive the day! Upload the photos and videos you captured at
            our wedding and they&apos;ll go straight to our album.
          </p>
        </div>

        {/* Card */}
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-2xl shadow-sm ring-1 ring-navy/5 p-6 sm:p-8"
        >
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
            <span className="text-navy font-medium">
              Tap to choose photos
            </span>
            <span className="text-navy/50 text-sm mt-1">
              or drag &amp; drop them here
            </span>
            <input
              ref={inputRef}
              type="file"
              accept="image/*,video/*"
              multiple
              onChange={(e) => addFiles(e.target.files)}
              className="hidden"
            />
          </label>

          {/* Selected files */}
          {files.length > 0 && (
            <ul className="mt-4 space-y-2">
              {files.map((file, i) => (
                <li
                  key={`${file.name}-${i}`}
                  className="flex items-center justify-between gap-3 rounded-lg bg-cream/60 px-3 py-2 text-sm"
                >
                  <span className="truncate text-navy">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => removeFile(i)}
                    className="text-navy/40 hover:text-navy shrink-0"
                    aria-label={`Remove ${file.name}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button
            type="submit"
            disabled={status === "uploading"}
            className="mt-6 w-full rounded-lg bg-navy hover:bg-navy-deep disabled:opacity-60 disabled:cursor-not-allowed text-cream font-medium py-3 transition"
          >
            {status === "uploading"
              ? "Uploading…"
              : files.length > 0
              ? `Upload ${files.length} photo${files.length === 1 ? "" : "s"}`
              : "Upload"}
          </button>

          {message && (
            <p
              className={`mt-4 text-center text-sm ${
                status === "error" ? "text-red-600" : "text-sage-deep"
              }`}
            >
              {message}
            </p>
          )}
        </form>

        <p className="text-center text-navy/40 text-xs mt-6">
          Your photos are shared privately with the couple.
        </p>
      </div>
    </main>
  );
}
