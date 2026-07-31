import { NextRequest } from "next/server";

export const runtime = "nodejs";

// Allow reasonably large photo payloads through the route handler.
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const scriptUrl = process.env.APPS_SCRIPT_URL;
  const token = process.env.UPLOAD_TOKEN;

  if (!scriptUrl) {
    return Response.json(
      { ok: false, error: "Server is not configured yet (missing APPS_SCRIPT_URL)." },
      { status: 500 }
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ ok: false, error: "Invalid upload." }, { status: 400 });
  }

  const name = (formData.get("name") as string | null)?.trim() || "";
  const files = formData.getAll("files").filter((f): f is File => f instanceof File);

  if (files.length === 0) {
    return Response.json({ ok: false, error: "No files received." }, { status: 400 });
  }

  // Convert each file to base64 so it can travel as JSON to Apps Script.
  const encoded = await Promise.all(
    files.map(async (file) => {
      const buffer = Buffer.from(await file.arrayBuffer());
      return {
        name: file.name || "photo",
        type: file.type || "application/octet-stream",
        data: buffer.toString("base64"),
      };
    })
  );

  try {
    const res = await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name, files: encoded }),
      // Apps Script web apps answer on a googleusercontent.com redirect.
      redirect: "follow",
    });

    const text = await res.text();
    let result: { ok?: boolean; count?: number; error?: string };
    try {
      result = JSON.parse(text);
    } catch {
      return Response.json(
        { ok: false, error: "Unexpected response from Google Drive." },
        { status: 502 }
      );
    }

    if (!res.ok || !result.ok) {
      return Response.json(
        { ok: false, error: result.error || "Google Drive rejected the upload." },
        { status: 502 }
      );
    }

    return Response.json({ ok: true, count: result.count ?? files.length });
  } catch {
    return Response.json(
      { ok: false, error: "Could not reach Google Drive. Please try again." },
      { status: 502 }
    );
  }
}
