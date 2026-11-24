// 500 Meters — ephemeral location-chat server.
// Real people only. No database, no disk storage, no history.
// Everything lives in memory and is deleted on leave / expiry / restart.
//
// Run:  node server.js          (listens on PORT, default 3000)
// Test: node test.js            (needs the server running on localhost:3000)
//
// Endpoints (all JSON):
//   GET  /health                       -> { ok, people, messages }
//   GET  /privacy                      -> the privacy policy as a web page
//     (so the Google Play listing has a public privacy-policy URL once
//      this server is deployed: <backend-url>/privacy)
//   POST /join    { username, lat, lng }          -> { sessionId, peopleWithin500 }
//   POST /heartbeat { sessionId, lat, lng }      -> { ok, peopleWithin500 }
//   POST /send    { sessionId, text }             -> { ok, id } or 400 { error }
//   GET  /room?sessionId=...                     -> { peopleWithin500, messages }
//   POST /leave   { sessionId }                   -> { ok } (deletes presence + messages)
//
// /room returns only messages whose sender is CURRENTLY within 500 m of the
// requester. If a sender has moved out of range, their message is still listed
// (so the client can show it blurred) but with text: null — the words never
// leave the server. The client must never invent or display text for them.

'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const RADIUS_M = 500;
const PRESENCE_TTL_MS = 90 * 1000;   // no heartbeat for 90 s = gone
const MESSAGE_TTL_MS = 10 * 60 * 1000; // messages expire after 10 min anyway
const MAX_TEXT = 500;

// --- Profanity filter: whole-word matching only ---------------------------
// Words are matched with \b word boundaries, so innocent words are never
// blocked: "hello" does NOT match "hell", "class" does NOT match "ass",
// "scrap" does NOT match "crap". Only the exact word (or its plural) counts.
const BLOCKED = [
  // explicit sexual words
  'fuck', 'fucking', 'fucked', 'fucker', 'shit', 'shitty', 'bitch', 'bitches',
  'bastard', 'damn', 'cunt', 'dick', 'dicks', 'cock', 'cocks', 'pussy',
  'pussies', 'whore', 'whores', 'slut', 'sluts', 'porn', 'sex', 'sexy',
  'boob', 'boobs', 'tits', 'tit', 'asshole', 'assholes', 'arsehole',
  'wank', 'wanker', 'prick', 'bollocks', 'bugger', 'twat',
  // slurs — never allowed
  'nigger', 'nigga', 'faggot', 'fag', 'dyke', 'retard', 'retarded',
  'chink', 'spic', 'kike', 'coon', 'gook', 'paki', 'raghead',
];
const BLOCKED_RE = new RegExp(
  '\\b(' + BLOCKED.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
  'i'
);
function containsProfanity(text) {
  return BLOCKED_RE.test(String(text || ''));
}

// --- In-memory store -------------------------------------------------------
const presences = new Map(); // sessionId -> { sessionId, username, lat, lng, lastSeen }
const messages = [];         // { id, sessionId, username, text, lat, lng, createdAt }

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

function prune(now) {
  for (const [id, p] of presences) {
    if (now - p.lastSeen > PRESENCE_TTL_MS) presences.delete(id);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (now - messages[i].createdAt > MESSAGE_TTL_MS) messages.splice(i, 1);
  }
}

function peopleWithin500(lat, lng, excludeSessionId) {
  let n = 0;
  for (const p of presences.values()) {
    if (p.sessionId === excludeSessionId) continue;
    if (haversineM(lat, lng, p.lat, p.lng) <= RADIUS_M) n++;
  }
  return n;
}

function validLatLng(lat, lng) {
  return (
    typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180
  );
}

// --- HTTP helpers ----------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// --- Server ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const now = Date.now();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  try {
    if (req.method === 'GET' && url.pathname === '/privacy') {
      // Privacy policy as a plain web page, for the Google Play listing.
      // Same text as PRIVACY.md in the project folder.
      const html = '<!doctype html><html><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Privacy Policy — 500 Meters</title></head>' +
        '<body style="font-family:monospace;max-width:640px;margin:32px auto;padding:0 16px;line-height:1.6">' +
        '<h1>Privacy Policy — 500 Meters</h1>' +
        '<p><strong>Developer:</strong> Everything Goes<br>' +
        '<strong>Contact email:</strong> everythinggoesthechannel@gmail.com<br>' +
        '<strong>Last updated:</strong> 24 November 2026</p>' +
        '<h2>What 500 Meters is</h2>' +
        '<p>500 Meters is an anonymous chat app. It lets people chat with other people ' +
        'who are within 500 metres of them. There are no accounts, no profiles, no ' +
        'friends lists and no message history.</p>' +
        '<h2>What the app collects, and why</h2>' +
        '<p>While you are in a chat session, the app sends the following to its server ' +
        'so the chat can work:</p><ul>' +
        '<li><strong>Your chosen username.</strong> You pick any username of at least ' +
        '6 characters. It is not linked to your name, phone number, email or any account.</li>' +
        '<li><strong>Your location (latitude and longitude).</strong> Your phone sends ' +
        'its location to the server so the server can work out who is within 500 metres ' +
        'of you. Your exact location is <strong>never shown to other people</strong> — ' +
        'other people only ever see a distance, for example "123 M AWAY".</li>' +
        '<li><strong>Your messages.</strong> Messages you send are delivered to people ' +
        'within 500 metres of you, and only to them.</li></ul>' +
        '<h2>What is NOT collected or kept</h2>' +
        '<p>The server keeps everything <strong>in memory only</strong>. Nothing is saved ' +
        'to disk and there is no database. There is <strong>no message history</strong>. ' +
        'When you press End Session, or close the app, or stop sending your location ' +
        'for 90 seconds, your presence and all of your messages are deleted. When a ' +
        'person you were chatting with moves more than 500 metres away, the server ' +
        'holds their words back — their old messages are shown blurred and the words ' +
        'themselves are never sent to your phone. The app does not collect your name, ' +
        'phone number, email address, contacts, photos or device identifiers. Nothing ' +
        'is sold to anyone and nothing is shared with advertisers or third parties ' +
        'for advertising.</p>' +
        '<h2>Bad words and safety</h2>' +
        '<p>The server checks messages for bad words before delivering them. A message ' +
        'containing a blocked word is never stored and never delivered. The app has no ' +
        'message history and an End Session button that immediately ends your session ' +
        'and deletes your messages.</p>' +
        '<h2>Children</h2>' +
        '<p>500 Meters is anonymous chat with strangers nearby. It is intended for ' +
        'adults and is not directed at children under 18.</p>' +
        '<h2>Contact</h2>' +
        '<p>If you have a question about this policy or about your data, contact: ' +
        '<strong>Everything Goes — everythinggoesthechannel@gmail.com</strong></p>' +
        '</body></html>';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Content-Length': Buffer.byteLength(html),
      });
      return res.end(html);
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      prune(now);
      return sendJson(res, 200, { ok: true, people: presences.size, messages: messages.length });
    }

    if (req.method === 'POST' && url.pathname === '/join') {
      const b = await readBody(req);
      const username = String(b.username || '').trim();
      if (username.length < 6) return sendJson(res, 400, { error: 'USERNAME MUST BE AT LEAST 6 CHARACTERS' });
      if (username.length > 30) return sendJson(res, 400, { error: 'USERNAME TOO LONG' });
      if (containsProfanity(username)) return sendJson(res, 400, { error: 'THAT USERNAME IS NOT ALLOWED' });
      if (!validLatLng(b.lat, b.lng)) return sendJson(res, 400, { error: 'LOCATION REQUIRED' });
      prune(now);
      const sessionId = crypto.randomUUID();
      presences.set(sessionId, { sessionId, username, lat: b.lat, lng: b.lng, lastSeen: now });
      return sendJson(res, 200, { sessionId, peopleWithin500: peopleWithin500(b.lat, b.lng, sessionId) });
    }

    if (req.method === 'POST' && url.pathname === '/heartbeat') {
      const b = await readBody(req);
      const p = presences.get(b.sessionId);
      if (!p) return sendJson(res, 404, { error: 'SESSION NOT FOUND' });
      if (!validLatLng(b.lat, b.lng)) return sendJson(res, 400, { error: 'LOCATION REQUIRED' });
      p.lat = b.lat; p.lng = b.lng; p.lastSeen = now;
      prune(now);
      return sendJson(res, 200, { ok: true, peopleWithin500: peopleWithin500(b.lat, b.lng, b.sessionId) });
    }

    if (req.method === 'POST' && url.pathname === '/send') {
      const b = await readBody(req);
      const p = presences.get(b.sessionId);
      if (!p) return sendJson(res, 404, { error: 'SESSION NOT FOUND' });
      const text = String(b.text || '').trim();
      if (!text) return sendJson(res, 400, { error: 'EMPTY MESSAGE' });
      if (text.length > MAX_TEXT) return sendJson(res, 400, { error: 'MESSAGE TOO LONG' });
      if (containsProfanity(text)) return sendJson(res, 400, { error: 'MESSAGE BLOCKED — KEEP IT CLEAN' });
      p.lastSeen = now;
      const msg = {
        id: crypto.randomUUID(), sessionId: p.sessionId, username: p.username,
        text, lat: p.lat, lng: p.lng, createdAt: now,
      };
      messages.push(msg);
      return sendJson(res, 200, { ok: true, id: msg.id });
    }

    if (req.method === 'GET' && url.pathname === '/room') {
      const sessionId = url.searchParams.get('sessionId');
      const me = presences.get(sessionId);
      if (!me) return sendJson(res, 404, { error: 'SESSION NOT FOUND' });
      me.lastSeen = now;
      prune(now);
      const out = [];
      for (const m of messages) {
        const sender = presences.get(m.sessionId);
        // Sender's CURRENT position decides range, not where they were when
        // they sent it. If they have left (presence gone), they are out.
        const dist = sender ? haversineM(me.lat, me.lng, sender.lat, sender.lng) : null;
        const inRange = dist !== null && dist <= RADIUS_M;
        out.push({
          id: m.id,
          username: m.username,
          // Text is withheld server-side when out of range — the client
          // must blur it and must not display any text for it.
          text: inRange ? m.text : null,
          outOfRange: !inRange,
          distanceMeters: dist === null ? null : Math.round(dist),
          createdAt: m.createdAt,
          mine: m.sessionId === sessionId,
        });
      }
      out.sort((a, b) => a.createdAt - b.createdAt);
      return sendJson(res, 200, {
        peopleWithin500: peopleWithin500(me.lat, me.lng, sessionId),
        messages: out,
      });
    }

    if (req.method === 'POST' && url.pathname === '/leave') {
      const b = await readBody(req);
      presences.delete(b.sessionId);
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].sessionId === b.sessionId) messages.splice(i, 1);
      }
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'NOT FOUND' });
  } catch (e) {
    return sendJson(res, 400, { error: String(e.message || 'BAD REQUEST') });
  }
});

setInterval(() => prune(Date.now()), 30 * 1000);

server.listen(PORT, () => {
  console.log('500 Meters server listening on port ' + PORT);
  console.log('Ephemeral only: in-memory, no database, no history saved.');
});
