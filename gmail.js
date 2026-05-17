// Gmail OAuth + fetch client (browser-only, no backend).
// Uses Google Identity Services (GIS) token client — popup flow, no redirect URI.
// Workspace Internal audience: no consent screen verification needed, tokens
// don't expire on the 7-day cycle, all makocabinets.com accounts work natively.

import { GOOGLE_CLIENT_ID, GMAIL_SCOPES } from './config.js';

let _tokenClient = null;
let _accessToken = null;
let _tokenExpiresAt = 0; // ms epoch
const SESSION_KEY = 'kcrm.gmail.token';

// Wait until the GIS library is ready.
function waitForGis() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        return resolve();
      }
      if (Date.now() - start > 8000) return reject(new Error('Google Identity Services failed to load. Check internet / ad-blocker.'));
      setTimeout(check, 100);
    })();
  });
}

function loadStoredToken() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const { token, expiresAt } = JSON.parse(raw);
    if (token && expiresAt > Date.now() + 60_000) {
      _accessToken = token;
      _tokenExpiresAt = expiresAt;
    }
  } catch (e) { /* ignore */ }
}
loadStoredToken();

function saveToken(token, expiresIn) {
  _accessToken = token;
  _tokenExpiresAt = Date.now() + (expiresIn * 1000);
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token, expiresAt: _tokenExpiresAt })); } catch (e) { /* quota */ }
}

export function isConnected() {
  return !!_accessToken && _tokenExpiresAt > Date.now() + 30_000;
}

export function disconnect() {
  if (_accessToken && window.google?.accounts?.oauth2) {
    try { window.google.accounts.oauth2.revoke(_accessToken, () => {}); } catch (e) { /* ignore */ }
  }
  _accessToken = null;
  _tokenExpiresAt = 0;
  sessionStorage.removeItem(SESSION_KEY);
}

// Open Google's consent popup (or silently re-issue if already consented this session).
export async function connect({ silent = false } = {}) {
  await waitForGis();
  if (!_tokenClient) {
    _tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: GMAIL_SCOPES,
      callback: () => { /* set per-request below */ },
    });
  }
  return new Promise((resolve, reject) => {
    _tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error_description || resp.error));
      if (!resp.access_token) return reject(new Error('No access token returned'));
      saveToken(resp.access_token, resp.expires_in || 3600);
      resolve(resp.access_token);
    };
    _tokenClient.error_callback = (err) => reject(new Error(err.message || err.type || 'OAuth failed'));
    try {
      _tokenClient.requestAccessToken({ prompt: silent ? '' : 'consent' });
    } catch (e) { reject(e); }
  });
}

async function ensureToken() {
  if (isConnected()) return _accessToken;
  // Try silent renewal first; if it fails the caller should show a "Connect Gmail" UI.
  try { return await connect({ silent: true }); } catch (e) { throw new Error('Not connected to Gmail. Click "Connect Gmail" first.'); }
}

// ----- Gmail REST helpers -----

async function gmailGet(path, params = {}) {
  const token = await ensureToken();
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me' + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 401) {
    // Token expired — clear and signal
    _accessToken = null; sessionStorage.removeItem(SESSION_KEY);
    throw new Error('Gmail token expired. Reconnect.');
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error('Gmail API error ' + res.status + ': ' + t.slice(0, 200));
  }
  return res.json();
}

function headerOf(payload, name) {
  const hs = payload?.headers || [];
  const h = hs.find(x => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

// Decode Gmail's URL-safe base64 body to UTF-8 string.
function decodeBody(data) {
  if (!data) return '';
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  try { return decodeURIComponent(escape(atob(b64))); }
  catch (e) { try { return atob(b64); } catch { return ''; } }
}

// Walk MIME parts and return the best plain-text body we can find.
function extractText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeBody(payload.body.data);
  if (payload.parts) {
    // Prefer text/plain; fall back to first part with text.
    const plain = payload.parts.find(p => p.mimeType === 'text/plain');
    if (plain) {
      const t = extractText(plain);
      if (t) return t;
    }
    for (const p of payload.parts) {
      const t = extractText(p);
      if (t) return t;
    }
  }
  if (payload.body?.data) return decodeBody(payload.body.data);
  return '';
}

// Parse "Name <email@host>" or just "email@host"
function parseFrom(raw) {
  if (!raw) return { name: null, email: '' };
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
  return { name: null, email: raw.trim().toLowerCase() };
}

// Fetch recent INBOX messages matching the query.
// Returns plain JS objects ready to pass to db.emails.create — caller is responsible
// for deduplication via message_id (we expose it on each result).
export async function fetchRecent({ maxResults = 20, query = 'in:inbox newer_than:7d -category:promotions -category:social' } = {}) {
  const list = await gmailGet('/messages', { maxResults: String(maxResults), q: query });
  const ids = (list.messages || []).map(m => m.id);
  if (ids.length === 0) return [];

  const out = [];
  // Sequential fetch to stay under the per-user 250 quota units/sec gmail limit (each message.get = 5 units).
  for (const id of ids) {
    try {
      const msg = await gmailGet('/messages/' + id, { format: 'full' });
      const from = parseFrom(headerOf(msg.payload, 'From'));
      const subject = headerOf(msg.payload, 'Subject');
      const dateHdr = headerOf(msg.payload, 'Date');
      const received = dateHdr ? new Date(dateHdr).toISOString() : new Date(parseInt(msg.internalDate || '0', 10)).toISOString();
      const body = extractText(msg.payload);
      out.push({
        message_id: msg.id,            // Gmail unique id (we use it for dedup)
        thread_id: msg.threadId,
        from_email: from.email || '(unknown)',
        from_name: from.name,
        subject: subject || null,
        snippet: msg.snippet || (body ? body.slice(0, 200) : null),
        body_text: body || null,
        received_at: received,
        source: 'gmail',
      });
    } catch (e) {
      console.warn('skip message ' + id + ':', e.message);
    }
  }
  return out;
}
