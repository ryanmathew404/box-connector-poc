# EuroOffice + Box connector (proof of concept)

Runs our EuroOffice fork against Box as the storage backend, no Nextcloud involved. The connector opens Box files in our editor, shows the FileOpen Protection tab to the file owner, stores the restriction flags in Box file metadata, enforces them for everyone else, and saves edits back to Box as new file versions.

Based on the MStrategy integration pattern with our permission feature added on top.

## What you need

- Docker Desktop
- A free Box developer account (takes about 20 minutes total, steps below)

## Box setup (one time)

1. Go to developer.box.com and create a free developer account.
2. In the Dev Console: Create Platform App, Custom App, App Type "Server" (Server Authentication with JWT).
3. In the app's Configuration tab:
   - App Access Level: App + Enterprise Access
   - Scopes: check "Write all files and folders stored in Box" and "Manage enterprise properties"
   - Under Add and Manage Public Keys click "Generate a Public/Private Keypair" (it may ask you to set up 2FA first). This downloads a JSON config file.
   - Save Changes.
4. Authorize the app: Admin Console, Integrations, Platform Apps Manager, approve the app.
5. Save the downloaded JSON file into this folder as `box-config.json`.

## Run it

```
docker compose up -d
```

First start takes a few minutes (image pull and npm install). Then:

1. Put any docx at `seed/FileOpen-Box-Demo.docx` (one is included) and load a test file into Box:
   `curl -X POST http://localhost:3000/api/seed`
   This prints a file id.
2. Open the editor:
   - Owner: `http://localhost:3000/open/<fileId>?as=owner`
   - Viewer: `http://localhost:3000/open/<fileId>?as=viewer`

Owner gets the Protection tab with Restrict Editing, Restrict Printing, and Restrict Save Copy. Toggle one, then reload the viewer link and see it enforced. The flags live on the file in Box metadata, and every save shows up in Box version history.

## Notes

- Owner and viewer are simulated with the URL switch. On localhost the owner link just works. If you expose this remotely, owner mode needs `&k=<OWNER_KEY>` (see `.env`, default `fo-owner-7391`). Real per user Box login is the production item.
- Restrictions apply when a document is opened. An already open session keeps its permissions until reload.
- `box-config.json` and `.env` are gitignored on purpose. Never commit your Box keys.
- The doc server image is our fork with the Protection tab compiled in, same image we use for the Nextcloud setup.
