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

    // Shared-secret check so only our app can upload.
    if (UPLOAD_TOKEN && body.token !== UPLOAD_TOKEN) {
      return json({ ok: false, error: "Unauthorized." });
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
