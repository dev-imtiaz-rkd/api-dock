# ApiDock

A local API client for building, sending and organising HTTP requests, with
built-in support for the Laravel APIs in this projects folder.

No dependencies, no build step. Needs Node.js 20+ (and PHP if you want to start
Laravel apps from it).

## Run

**Desktop app (Windows):** install `dist/ApiDock-Setup-1.0.0.exe`, or run
`dist/ApiDock-1.0.0-portable.exe` without installing. The app runs its own
local server on a free port, so nothing else needs to be running. Its data
lives in `%APPDATA%\ApiDock\data`.

**From source:**

```bash
npm install
npm run app        # desktop window (Electron)
npm start          # or: plain server at http://localhost:4000 (data in ./data)
```

**Build the Windows installer and portable exe:**

```bash
npm run build      # → dist/ApiDock-Setup-<version>.exe and dist/ApiDock-<version>-portable.exe
```

**Publish an update** (installed apps pick it up automatically):

```bash
# 1. raise "version" in package.json   2. commit   3.
npm run release
```

The release script builds the installer, checks its checksums, and uploads
it to `https://apidock.ebareidechutionek.cfd/updates/`. It needs
`.release.env` (git-ignored) with `UPDATES_URL` and `UPDATES_TOKEN`; the
server keeps only the token's SHA-256. Installed apps check 10 seconds after
start and every 4 hours, and show a card. One click downloads the update and
restarts into it.

If `npm install` skips Electron's download (npm's install-script policy), run
`node node_modules/electron/install.js` once.

Inside the app: **F5** reloads, **F11** toggles full screen, and
**Ctrl+Shift+I** opens DevTools.

## Layout

ApiDock is organised by collection:

- **Dock (far left)**: one tile per collection, showing its initials in its
  own color. Clicking a tile switches the whole screen to that collection:
  its tree, its open tabs and its accent color. Tabs from different
  collections never mix, and each collection remembers its own open tabs.
  Alt+1…9 jumps to a collection.
- **Built-in workspaces (bottom of the dock)**: Drafts & History (requests
  not in any collection yet) and Services.
- **Request screen**: the request is on the left and the response on the
  right (use **Stack** to put them top and bottom). The line under the URL
  shows the exact URL that will be sent, the auth in use, and any undefined
  or empty variables.
- **Saving a draft** into a collection moves its tab into that collection's
  workspace.

## Features

- **Collections**: folders and requests in a tree. You can rename, duplicate,
  reorder and delete them, search them, and right-click for more actions.
- **Import / export**: Postman v2.0/v2.1 collections and environments (drag
  and drop, paste the JSON, or pick from files the project scan found). You
  can also paste a `curl` command into the URL bar or the Import dialog.
  Collections export back to Postman v2.1.
- **Request builder**:
  - Method and URL
  - Query params, kept in sync with the URL
  - Path variables (`/users/:id`)
  - Headers, with a bulk-edit mode
  - Auth: Bearer, Basic, API Key, or inherit from the folder or collection
  - Body: raw JSON, Text, XML or HTML with a highlighting editor and a
    Beautify button; `x-www-form-urlencoded`; or `form-data` with file uploads
  - Docs (a description for the request)
- **Response viewer**:
  - Status, time and size
  - Collapsible pretty JSON
  - Raw view with highlighting and line wrap
  - HTML and image preview
  - Response headers, plus the exact request that was sent
  - Copy and download
- **Variable sets, per collection**: a collection holds several variable sets.
  The variables imported with the collection are its **Default** set. Use
  **Import variable set** (the ⋯ menu in the side-panel footer) to add more
  sets from a Postman collection (its variables only), a Postman environment,
  a `.env` / `KEY=value` file or pasted text, or another collection in
  ApiDock. The **Variables** dropdown in the footer picks the one set the
  collection uses. Sets never mix. Use `{{name}}` anywhere; undefined
  variables are shown in red. Dynamic values like `{{$guid}}` and
  `{{$timestamp}}` are supported.
- **Token capture**: when a response has a JSON field whose name contains
  "token" (for example `access_token`), ApiDock copies it into the variable
  with the same name. Logging in therefore sets the token for every other
  request.
- **Runner**: runs a whole collection or folder in order and gives a
  pass / 4xx / fail summary. It selects only GET requests by default, because
  other methods change data.
- **Code snippets**: cURL, JavaScript fetch, Python requests, and PHP cURL.
- **History, tabs, light and dark theme, resizable panes, and keyboard
  shortcuts** (Ctrl+Enter to send, Ctrl+S to save, Ctrl+T new tab, Ctrl+W
  close tab).
- **Services**: scans the parent folder for Laravel apps. **Start** runs
  `php artisan serve` on a free port (8101 and up) and shows its output.
  **Create from routes** turns `php artisan route:list` into a collection.

## Teams

The **Team** button at the bottom of the dock signs you in with Google. From
there you can:

- create teams and invite people by their Google email; they accept the
  invite in their own ApiDock;
- share a collection with **⋯ → Share with team**, giving each member
  **Viewer** (can send requests) or **Editor** (can change requests and
  variables) access.

Shared collections live on the team server and stay in sync for everyone. If
two people edit at once, ApiDock warns instead of overwriting. Your choice of
active variable set stays personal. The session token is kept locally in
`data/cloud.json`, and the UI reaches the team server only through the local
app.

### Team server (`cloud/server.js`)

The team server has no dependencies. It needs Node 22.13 or newer, because it
uses the built-in SQLite. Configure it with a `.env` file next to the script:

```
PUBLIC_URL=https://apidock.ebareidechutionek.cfd
PORT=4010
DB_PATH=/var/www/nginx/apidock/data/apidock-cloud.db
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

The live deployment on the Dhaka server is set up as follows:

| Part | Where |
| --- | --- |
| Code | `/var/www/nginx/apidock/` |
| Process | pm2 process `apidock-team` |
| Web server | nginx site `apidock.ebareidechutionek.cfd` |
| HTTPS | Let's Encrypt certificate, renewed by certbot |

The Google OAuth client is a *Web application* with redirect URI
`https://apidock.ebareidechutionek.cfd/auth/google/callback`.

## Where data lives

All data is kept in `data/` as plain JSON:

| File | Contents |
| --- | --- |
| `data/collections/<id>.json` | One file per collection, including its environments |
| `data/history.json` | The last 200 requests |
| `data/settings.json` | Scan roots, the active environment, and service ports |

Files picked for form-data uploads are never written to disk.

## Not supported

Postman pre-request and test scripts (`pm.*`). They are kept on import and
export, but they don't run. Token capture covers the usual case of a login
request setting a token.
