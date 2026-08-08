# Wedding Photo Uploader — Setup

A minimal Next.js page where wedding guests upload photos, which land in **your Google Drive** via a Google Apps Script backend.

```
Guest's browser  →  /api/upload (Next.js)  →  Apps Script Web App  →  Google Drive folder
```

The Apps Script URL and secret token live server-side, so they are never exposed to guests.

---

## 1. Create the Drive folder

1. In [Google Drive](https://drive.google.com), create a folder, e.g. **"Wedding Photos"**.
2. Open it and copy the **folder ID** from the URL:
   `https://drive.google.com/drive/folders/`**`THIS_LONG_ID`**

## 2. Create the Apps Script

1. Go to <https://script.google.com> → **New project**.
2. Delete the sample code and paste in the contents of [`google-apps-script/Code.gs`](google-apps-script/Code.gs).
3. Open **Project Settings** (the gear icon) → **Script Properties** → **Add script property** twice:
   | Property | Value |
   | --- | --- |
   | `FOLDER_ID` | the folder ID from step 1 |
   | `UPLOAD_TOKEN` | the token already generated in your `.env.local` |
4. **Deploy → New deployment → select type "Web app"**:
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`
5. Click **Deploy**, authorize the script when prompted, and copy the **Web app URL** (ends in `/exec`).

> Open that URL in a browser — you should see `{"ok":true,"message":"Wedding uploader is running."}`.

## 3. Connect the web app

Open `.env.local` and paste the Web app URL:

```
APPS_SCRIPT_URL=https://script.google.com/macros/s/AKfyc.../exec
UPLOAD_TOKEN=<already filled in — must match the Apps Script property>
```

## 4. Run it

```bash
npm run dev
```

Visit <http://localhost:3000>, upload a test photo, and confirm it appears in your Drive folder (guests who enter a name get their own subfolder).

---

## Deploying for real guests

Host the app anywhere that runs Next.js (e.g. **Vercel**: `npx vercel`). Add the same two environment variables (`APPS_SCRIPT_URL`, `UPLOAD_TOKEN`) in the host's project settings, then share the site URL with your guests.

## Notes & limits

- **Re-deploy after editing `Code.gs`:** use **Manage deployments → edit → New version**, or the URL won't change but the code will.
- **Upload size:** photos are resized in the guest's browser (longest edge ~3000 px, high quality) and uploaded **one file per request**, so each request stays well under Vercel's ~4.5 MB body cap. Guests can select 50+ at a time; uploads run 3 at a time with a per-photo progress bar and auto-retry. To keep originals or change quality, edit `DEFAULTS` in `app/lib/uploader.ts`.
- **Videos & very large files:** these can't be compressed in the browser and will exceed Vercel's ~4.5 MB limit, so they're flagged "too large to upload here" rather than hanging. Collect large videos another way (e.g. a shared Drive/Photos link), or self-host the app to lift the cap.
- **Background uploads:** true set-and-forget (closing the tab) isn't possible on mobile web — iOS Safari suspends the page when backgrounded. The app requests a screen wake-lock and warns before leaving, so guests should keep the tab in the foreground while uploading.
- **Security:** the `UPLOAD_TOKEN` stops random people from posting to your Apps Script directly. Keep it out of any public/client code (it already lives only in `.env.local`).
