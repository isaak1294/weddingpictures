/**
 * Wedding photo uploader — Google Apps Script backend.
 *
 * Receives photos from the Next.js app and saves them to a Google Drive folder.
 *
 * SETUP (see SETUP.md for the full walkthrough):
 *   1. Create a Drive folder for the photos and copy its ID from the URL.
 *   2. In this project: Project Settings → Script Properties, add:
 *        FOLDER_ID     = <the Drive folder ID>
 *        UPLOAD_TOKEN  = <any long random string>
 *   3. Deploy → New deployment → type "Web app":
 *        Execute as:            Me
 *        Who has access:        Anyone
 *   4. Copy the Web app URL into the Next.js app's .env.local as APPS_SCRIPT_URL,
 *      and use the same UPLOAD_TOKEN value there.
 */

function doPost(e) {
  try {
    var props = PropertiesService.getScriptProperties();
    var FOLDER_ID = props.getProperty("FOLDER_ID");
    var UPLOAD_TOKEN = props.getProperty("UPLOAD_TOKEN");

    if (!FOLDER_ID) {
      return json({ ok: false, error: "FOLDER_ID script property is not set." });
    }

    var body = JSON.parse(e.postData.contents);

    // Auth: accept either the raw shared secret (server-to-server proxy path)
    // or a valid, unexpired signed ticket (direct-from-browser path).
    if (UPLOAD_TOKEN) {
      var okToken = body.token === UPLOAD_TOKEN;
      var okTicket = verifyTicket(body.ticket, UPLOAD_TOKEN);
      if (!okToken && !okTicket) {
        return json({ ok: false, error: "Unauthorized." });
      }
    }

    if (!body.files || !body.files.length) {
      return json({ ok: false, error: "No files received." });
    }

    var folder = DriveApp.getFolderById(FOLDER_ID);

    // Optionally group each guest's photos into their own subfolder.
    var guest = (body.name || "").toString().trim();
    var target = guest ? getOrCreateSubfolder(folder, guest) : folder;

    var count = 0;
    for (var i = 0; i < body.files.length; i++) {
      var f = body.files[i];
      var bytes = Utilities.base64Decode(f.data);
      var blob = Utilities.newBlob(bytes, f.type || "application/octet-stream", f.name || "photo");
      target.createFile(blob);
      count++;
    }

    return json({ ok: true, count: count });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// Simple health check so you can open the Web app URL in a browser.
function doGet() {
  return json({ ok: true, message: "Wedding uploader is running." });
}

// Verifies a `<expiry>.<hmac>` ticket signed with the shared secret. The ticket
// lets the browser upload directly without ever holding the real secret.
function verifyTicket(ticket, secret) {
  if (!ticket || !secret) return false;
  var parts = String(ticket).split(".");
  if (parts.length !== 2) return false;

  var exp = parseInt(parts[0], 10);
  if (!exp || exp < Date.now() / 1000) return false; // missing or expired

  var expected = hmacSha256Hex(secret, parts[0]);
  return constantTimeEquals(expected, parts[1]);
}

function hmacSha256Hex(secret, message) {
  var raw = Utilities.computeHmacSha256Signature(message, secret);
  var hex = "";
  for (var i = 0; i < raw.length; i++) {
    var b = (raw[i] < 0 ? raw[i] + 256 : raw[i]).toString(16);
    hex += b.length === 1 ? "0" + b : b;
  }
  return hex;
}

function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function getOrCreateSubfolder(parent, name) {
  // Strip characters that are awkward in folder names.
  var safe = name.replace(/[\\\/:*?"<>|]/g, "").slice(0, 80) || "Guest";
  var existing = parent.getFoldersByName(safe);
  if (existing.hasNext()) {
    return existing.next();
  }
  return parent.createFolder(safe);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
