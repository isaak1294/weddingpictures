import crypto from "node:crypto";

export const runtime = "nodejs";

// Issues a short-lived, signed ticket that lets the browser upload directly to
// the Apps Script Web App without ever holding the real UPLOAD_TOKEN. The
// ticket is `<expiry>.<hmac>`, signed with UPLOAD_TOKEN — the same secret the
// Apps Script side already knows, so it can verify without extra config.

const TICKET_TTL_SECONDS = 2 * 60 * 60; // 2 hours — long enough for a big batch

export async function POST() {
  const scriptUrl = process.env.APPS_SCRIPT_URL;
  const token = process.env.UPLOAD_TOKEN;

  if (!scriptUrl || !token) {
    return Response.json(
      { ok: false, error: "Direct uploads are not configured on the server." },
      { status: 500 }
    );
  }

  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
  const sig = crypto
    .createHmac("sha256", token)
    .update(String(exp))
    .digest("hex");

  return Response.json({
    ok: true,
    ticket: `${exp}.${sig}`,
    exp,
    url: scriptUrl,
  });
}
