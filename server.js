// Box connector proof of concept — MStrategy pattern + FileOpen owner permissions.
//
// Plays the role the Nextcloud app plays in our stack:
//   - hands the editor a Box download URL in a JWT-signed config
//   - injects foOwnerPerms for the owner (Protection tab renders)
//   - strips permissions for non-owners (editor enforces, incl. shortcuts)
//   - receives fo:savePerms toggles and persists them to Box file metadata
//   - uploads saved documents back to Box as new file versions
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const BoxSDK = require('box-node-sdk');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PORT = process.env.PORT || 3000;
// Must match JWT_SECRET on the doc server (see docker-compose.yml)
const EO_JWT_SECRET = process.env.EO_JWT_SECRET || 'euro-office-dev-jwt-secret-key-2026';
const DOC_SERVER_PUBLIC = process.env.DOC_SERVER_PUBLIC_URL || 'http://localhost:8080';
const DOC_SERVER_INTERNAL = process.env.DOC_SERVER_INTERNAL_URL || 'http://eo';
// How the doc server (eo) reaches THIS app over the docker network for save callbacks.
const CALLBACK_BASE = process.env.CALLBACK_BASE || 'http://box-poc:3000';
// Base the editor page uses to load api.js. Empty = same origin: this app proxies the
// doc server, so one hostname (localhost:3000 or the ngrok domain) serves everything.
const EDITOR_BASE = process.env.EDITOR_BASE || '';
// Owner mode needs this key when accessed remotely (viewers must not self-promote).
// Localhost skips the check so local dev keeps working unchanged.
const OWNER_KEY = process.env.OWNER_KEY || 'fo-owner-7391';

function isOwnerReq(req) {
  if (req.query.as !== 'owner') return false;
  const local = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
  return local || req.query.k === OWNER_KEY;
}

const boxConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'box-config.json'), 'utf8'));
const sdk = BoxSDK.getPreconfiguredInstance(boxConfig);
const box = sdk.getAppAuthClient('enterprise');

const app = express();
// JSON parsing only on our own API — proxied doc-server requests must stream raw.
app.use('/api', express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const toBool = (v) => String(v) !== 'false';

async function getFlags(fileId) {
  try {
    const md = await box.files.getMetadata(fileId, box.metadata.scopes.GLOBAL, 'properties');
    return {
      allowPrint: toBool(md.allowPrint ?? 'true'),
      allowDownload: toBool(md.allowDownload ?? 'true'),
      allowEdit: toBool(md.allowEdit ?? 'true'),
    };
  } catch (e) {
    return { allowPrint: true, allowDownload: true, allowEdit: true }; // no metadata yet
  }
}

function docType(ext) {
  ext = (ext || '').toLowerCase();
  if (['xlsx', 'xls', 'ods', 'csv'].includes(ext)) return 'cell';
  if (['pptx', 'ppt', 'odp'].includes(ext)) return 'slide';
  return 'word';
}

// Build + sign the editor config (mirrors EditorApiController in the Nextcloud app)
app.get('/api/config/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const asOwner = isOwnerReq(req);

    await box.files.update(fileId, { shared_link: { access: 'open', permissions: { can_download: true } } });
    const file = await box.files.get(fileId, { fields: 'name,extension,shared_link,file_version' });
    const flags = await getFlags(fileId);

    const config = {
      document: {
        fileType: file.extension,
        // Per-open nonce so config changes never hit a stale doc-server cache entry
        // (a key reused across configs makes the editor serve its old read-only state).
        key: `${fileId}_${file.file_version.id}_${Date.now().toString(36)}`,
        title: file.name,
        url: file.shared_link.download_url,
        permissions: { edit: true, download: true, print: true, copy: true, comment: true, review: true },
      },
      documentType: docType(file.extension),
      editorConfig: {
        mode: 'edit',
        lang: 'en',
        // Required for edit mode: without a callbackUrl the doc server opens read-only.
        callbackUrl: `${CALLBACK_BASE}/api/callback/${fileId}`,
        user: asOwner ? { id: 'poc-owner', name: 'Owner (Ryan)' } : { id: 'poc-viewer', name: 'Shared User' },
        customization: { autosave: true, forcesave: true },
      },
    };

    if (asOwner) {
      config.editorConfig.customization.foOwnerPerms = {
        isOwner: true,
        allowEdit: flags.allowEdit,
        allowPrint: flags.allowPrint,
        allowDownload: flags.allowDownload,
      };
    } else {
      if (!flags.allowPrint) config.document.permissions.print = false;
      if (!flags.allowDownload) { config.document.permissions.download = false; config.document.permissions.copy = false; }
      if (!flags.allowEdit) { config.document.permissions.edit = false; config.editorConfig.mode = 'view'; }
    }

    const token = jwt.sign(config, EO_JWT_SECRET, { algorithm: 'HS256' });
    res.json({ config, token, flags, asOwner });
  } catch (e) {
    console.error('[config]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Persist the owner's Protection-tab toggles to Box file metadata (properties).
// Atomic upsert (patch, create on 404) and a per-file queue so rapid toggles
// can't race each other into 409s and overwrite one another.
const permsQueues = new Map();

async function writePerms(fileId, values) {
  const scope = box.metadata.scopes.GLOBAL;
  const ops = Object.entries(values).map(([k, v]) => ({ op: 'add', path: '/' + k, value: v }));
  try {
    await box.files.updateMetadata(fileId, scope, 'properties', ops);
  } catch (e) {
    if (e.statusCode === 404) await box.files.addMetadata(fileId, scope, 'properties', values);
    else throw e;
  }
}

app.put('/api/perms/:fileId', (req, res) => {
  const { fileId } = req.params;
  const b = req.body || {};
  const values = {
    allowPrint: String(b.allowPrint !== false),
    allowDownload: String(b.allowDownload !== false),
    allowEdit: String(b.allowEdit !== false),
  };
  const prev = permsQueues.get(fileId) || Promise.resolve();
  const next = prev
    .then(() => writePerms(fileId, values))
    .then(() => {
      console.log(`[perms] ${fileId} =>`, values);
      res.json({ ok: true, saved: values });
    })
    .catch((e) => {
      console.error('[perms]', e.message);
      res.status(500).json({ error: e.message });
    });
  permsQueues.set(fileId, next.catch(() => {}));
});

// The doc server puts its cache URL for the edited file into the callback/downloadAs
// event. Depending on how eo was configured that host may be its public or internal
// name, so try a few candidates over the docker network.
async function fetchEditedFile(url) {
  const candidates = [url, url.replace(DOC_SERVER_PUBLIC, DOC_SERVER_INTERNAL)];
  try { const u = new URL(url); candidates.push(`${DOC_SERVER_INTERNAL}${u.pathname}${u.search}`); } catch (e) {}
  for (const c of [...new Set(candidates)]) {
    try { const r = await fetch(c); if (r.ok) return Buffer.from(await r.arrayBuffer()); } catch (e) {}
  }
  throw new Error('could not fetch edited file from any candidate url');
}

// Save callback — the doc server calls this as users edit/close. status 2 = ready to
// save, 6 = forcesave. On either, pull the edited file and store it as a new Box version.
// This is what actually enables edit mode (see callbackUrl in the config).
app.post('/api/callback/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const b = req.body || {};
    if (b.status === 2 || b.status === 6) {
      const buf = await fetchEditedFile(b.url);
      await box.files.uploadNewFileVersion(fileId, buf);
      console.log(`[callback] ${fileId}: saved new Box version (${buf.length} bytes, status ${b.status})`);
    } else {
      console.log(`[callback] ${fileId}: status ${b.status} (no save)`);
    }
    res.json({ error: 0 });
  } catch (e) {
    console.error('[callback]', e.message);
    res.json({ error: 0 }); // ack so the doc server does not lock the key; error is logged
  }
});

// Manual "Save to Box" button path (downloadAs) — kept as a belt-and-suspenders export.
app.post('/api/save/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const tempUrl = (req.body && req.body.url) || '';
    if (!tempUrl) return res.status(400).json({ error: 'missing url' });
    const buf = await fetchEditedFile(tempUrl);
    await box.files.uploadNewFileVersion(fileId, buf);
    console.log(`[save] ${fileId}: uploaded new version (${buf.length} bytes)`);
    res.json({ ok: true, bytes: buf.length });
  } catch (e) {
    console.error('[save]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Convenience: upload a local docx into the service account's space (avoids sharing friction)
app.post('/api/seed', async (req, res) => {
  try {
    const name = (req.body && req.body.name) || 'FileOpen-Box-Demo.docx';
    const src = path.join(__dirname, 'seed', name);
    if (!fs.existsSync(src)) return res.status(404).json({ error: `put a docx at seed/${name} first` });
    const folder = await box.folders.create('0', `fileopen-poc-${Date.now()}`).catch(() => null);
    const folderId = folder ? folder.id : '0';
    const created = await box.files.uploadFile(folderId, name, fs.createReadStream(src));
    const entry = created.entries ? created.entries[0] : created;
    console.log(`[seed] uploaded ${name} -> file id ${entry.id}`);
    res.json({ ok: true, fileId: entry.id, name: entry.name });
  } catch (e) {
    console.error('[seed]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// The editor page
app.get('/open/:fileId', (req, res) => {
  const owner = isOwnerReq(req);
  let html = fs.readFileSync(path.join(__dirname, 'public', 'editor.html'), 'utf8');
  html = html
    .replace(/__DOC_SERVER__/g, EDITOR_BASE)
    .replace(/__FILE_ID__/g, req.params.fileId)
    .replace(/__AS__/g, owner ? 'owner' : 'viewer')
    // the key is only ever rendered into an authorized owner's page
    .replace(/__KEY__/g, owner ? OWNER_KEY : '')
    .replace(/__OWNER_LINK__/g, owner ? '' : 'display:none');
  res.type('html').send(html);
});

app.get('/', (_req, res) =>
  res.type('text/plain').send('box-connector-poc up.\nOpen /open/<boxFileId>?as=owner or ?as=viewer'));

// Everything that is not ours goes to the doc server (web-apps assets, sdkjs, cache,
// co-editing websockets). One public hostname serves the whole demo.
const dsProxy = createProxyMiddleware({
  target: DOC_SERVER_INTERNAL,
  changeOrigin: false, // keep the original Host so the doc server builds URLs for it
  // NOTE: no xfwd here — it would overwrite ngrok's X-Forwarded-Proto=https with
  // http and the doc server would mint mixed-content URLs (browser blocks: error -4).
  ws: false, // upgrades wired manually below
});
app.use(dsProxy);

const server = app.listen(PORT, () => console.log(`box-connector-poc listening on :${PORT}`));
server.on('upgrade', dsProxy.upgrade); // co-editing socket.io passthrough
