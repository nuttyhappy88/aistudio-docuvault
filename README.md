# DocuVault (Google AI Studio edition)

One web app for documents, workflows, chat and announcements across your businesses. It installs on phones and computers as an app (PWA) and works offline, so the separate Windows program and Android app are no longer needed.

- **Sign-in:** Google accounts. The first person to sign in becomes the owner (super admin): use the **main company Google account**. Anyone else who signs in waits until the owner approves them, unless the owner invited their email first.
- **Records:** documents, workflows, chat, announcements and people are kept in this app's Firestore database (Google Cloud, free starter tier).
- **Files:** every file goes into one **DocuVault** folder in the company Google Drive. Staff never get the Drive itself: the app stores and opens files for them and only shows each person what their access allows.
- **Chat:** every business has its own channel. There are also groups and direct chats, `@mentions`, document cards made with `#`, file attachments (with an option to send them to the Inbox for filing), and announcements that can ask people to confirm they have read them.

The older setup (Floot server, office PC server, DocuVault Go) is separate and keeps working.

## Put it in Google AI Studio

1. Open [Google AI Studio](https://aistudio.google.com) → **Build**.
2. Import this repository: **GitHub** → `nuttyhappy88/aistudio-docuvault`. (Or upload the files.)
3. Turn on Firebase. In the AI Studio chat, type: **"Enable Firebase for this app with Firestore and Google sign-in."** AI Studio creates the database and writes `firebase-applet-config.json`.
4. Apply the security rules. Ask the agent: **"Deploy the firestore.rules file in this project to Firestore."** If it can't, open Firebase console → Firestore → Rules, paste the contents of `firestore.rules`, and press **Publish**.
5. Open the preview and press **Sign in with Google** using the main company account. Enter your first business name and code.
6. Connect the company Google Drive. The **Company Drive** page walks you through this:
   1. Enable the Google Drive API.
   2. Publish the Google Auth Platform app (External audience).
   3. Create a **Web application** OAuth client and add the redirect URI shown on the page.
   4. In AI Studio, open **Secrets** and add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then restart the app.
   5. Press **Connect the company Google account**.
7. Publish: in AI Studio press **Deploy app** (Cloud Run). Then go back to the OAuth client and add the published address's redirect URI as well (`https://<your-app-address>/api/drive/callback`).
8. Share the published address with staff. They sign in with Google, you approve them on **People & approvals**, and they install it from the browser (Android: ⋮ → Install app; iPhone: Share → Add to Home Screen; Windows/Mac: the install icon in the address bar).

## How it is built

| Part | File |
|---|---|
| Web server (Cloud Run): serves the app, connects the company Drive, uploads and downloads files | `server.ts` |
| Google sign-in and Firestore (the only Firebase code) | `src/js/cloud.js` |
| Offline copy, outbox, live updates, file transfer | `src/js/sync.js` |
| Screens | `src/js/app.js`, `src/styles.css` |
| Who may read and change what | `firestore.rules` |
| Offline app shell, install info | `public/sw.js`, `public/manifest.webmanifest` |

**Security notes**

- Access is enforced by `firestore.rules`, not by the app's screens.
- The server reads Firestore *as the person asking*, so a file opens only if the rules let that person read its record.
- The company Drive permission is stored encrypted, using a key derived from `GOOGLE_CLIENT_SECRET`. If you change that secret, connect Drive again.
- Files shared in chat can be opened for 3 days (`CHAT_FILE_DAYS`). They stay in the Drive, and the owner and the person who shared them can still open them.

**Free tier limits to know:** Firestore's free tier allows about 50,000 reads and 20,000 writes per day, which is plenty for a small team. Each person opening the app reads the records they can see, so very large archives or many staff could pass it. The Firebase console shows usage.

## Local development

```
npm install
npm run dev          # http://localhost:3000
npm run build && npm start
```

Copy `.env.example` to `.env` for the Drive secrets. `firebase-applet-config.json` must hold your Firebase web config.
