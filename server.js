// Ozzy Sports — AI sports commentator for live streams.
//
// Endpoints:
//   GET  /api/resolve?url=...     resolve a stream page (e.g. an NOS livestream page) to an HLS .m3u8 URL
//   GET  /api/proxy?url=...       CORS-friendly HLS proxy (rewrites playlists so segments come through us too)
//   POST /api/commentary          frames + history in, commentary text + TTS audio (base64 mp3) out
//   GET  /api/health              config sanity check for the front-end
//
// The proxy exists for two reasons: browsers can't fetch most third-party HLS
// playlists directly (CORS), and frame capture from a <video> onto a canvas is
// only allowed when the media is served with CORS headers.

import express from 'express';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns/promises';
import net from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3210;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';
const TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'ash';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const ALLOW_PRIVATE_NETWORKS = process.env.ALLOW_PRIVATE_NETWORKS === '1';

const app = express();

// Optional site-wide password (HTTP Basic auth, any username). Strongly
// recommended on a public deployment: /api/commentary spends OpenAI credits
// and /api/proxy relays streams on behalf of whoever can reach the server.
if (APP_PASSWORD) {
  const digest = (s) => createHash('sha256').update(s).digest();
  const expected = digest(APP_PASSWORD);
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const decoded = header.startsWith('Basic ')
      ? Buffer.from(header.slice(6), 'base64').toString()
      : '';
    const password = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : '';
    if (password && timingSafeEqual(digest(password), expected)) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="Ozzy Sports"');
    res.status(401).send('Authentication required');
  });
}

app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// SSRF guard: the resolver and proxy fetch user-supplied URLs, so refuse
// anything that resolves to a private/internal address unless explicitly
// allowed (ALLOW_PRIVATE_NETWORKS=1, for local development fixtures).
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7));
    return (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fe80') ||
      lower.startsWith('fc') ||
      lower.startsWith('fd')
    );
  }
  const o = ip.split('.').map(Number);
  return (
    o[0] === 0 ||
    o[0] === 10 ||
    o[0] === 127 ||
    (o[0] === 100 && o[1] >= 64 && o[1] <= 127) ||
    (o[0] === 169 && o[1] === 254) ||
    (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
    (o[0] === 192 && o[1] === 168)
  );
}

async function assertPublicHost(url) {
  if (ALLOW_PRIVATE_NETWORKS) return;
  const { hostname } = new URL(url);
  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) {
    const err = new Error('Refusing to fetch private or internal addresses.');
    err.status = 403;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

const PERSONA = `You are "Ozzy", a live sports commentator hired to replace the dry,
monotone official commentary of a broadcast. Your style is a blend of two comedic voices:

1. An irreverent Australian larrikin commentator: high energy, absurd nicknames for the
   athletes based on what you can see (kit colour, hair, riding style), colourful Aussie
   slang ("mate", "carn", "she'll be right", "absolute weapon"), sudden shouted excitement
   when something happens, and mock-epic narration of mundane moments.

2. A weary, self-deprecating observational stand-up: mid-race existential asides, deadpan
   honesty about how little you understand the sport's rules, comparisons to everyday
   misery ("that climb looks like my commute if my commute hated me personally"), and
   trailing off into resigned sighs.

Rules:
- You are watching still frames from a LIVE stream. Comment ONLY on what is visible or
  plausible for the sport. Never invent specific scores, times, or athlete names unless
  they are readable on-screen (graphics, jerseys, scoreboards).
- 1 to 3 sentences per turn. This will be spoken aloud; keep it punchy and rhythmic.
- Do not repeat jokes or phrasings from your recent lines (provided as history).
- If nothing changed since the last frames, do a short observational aside instead of
  narrating the same thing again.
- Profanity policy: {SPICE}.
- Never use slurs, never mock protected characteristics, never target the crowd or
  private individuals — punch at the situation, the sport, and yourself.
- Output ONLY the spoken line. No stage directions, no quotes, no emoji.`;

const SPICE_LEVELS = {
  family: 'strictly family friendly, no swearing at all — replace swears with inventive G-rated exclamations ("strewth!", "flippin heck")',
  cheeky: 'mild swearing allowed (bloody, hell, damn, arse, crap) but nothing stronger',
  full: 'casual pub-level swearing allowed where it lands a joke, but never slurs and never aimed at a person',
};

const TTS_INSTRUCTIONS = `Voice: energetic Australian sports commentator with a rough,
warm, blokey edge. Pace: fast and punchy on action, then dropping to a slow, tired,
deadpan mutter for the observational asides — like a stand-up comedian who has seen too
much. Big dynamic swings: genuinely SHOUT the exciting bits, almost sigh the sarcastic
bits. Sound live and off-the-cuff, not like reading a script.`;

// ---------------------------------------------------------------------------
// Stream URL resolution
// ---------------------------------------------------------------------------

const M3U8_RE = /https?:\\?\/\\?\/[^"'\s<>\\]+?\.m3u8[^"'\s<>\\]*/g;

function unescapeUrl(u) {
  return u.replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
}

async function findM3u8InText(text) {
  const found = [...new Set((text.match(M3U8_RE) || []).map(unescapeUrl))];
  // Prefer master playlists / obvious stream hosts over preview thumbnails etc.
  found.sort((a, b) => {
    const score = (u) => (/master|index|live/i.test(u) ? 0 : 1);
    return score(a) - score(b);
  });
  return found;
}

app.get('/api/resolve', async (req, res) => {
  const pageUrl = req.query.url;
  if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) {
    return res.status(400).json({ error: 'Provide a valid http(s) url parameter.' });
  }
  // A direct playlist URL needs no resolving.
  if (/\.m3u8(\?|$)/i.test(pageUrl)) {
    return res.json({ streams: [pageUrl], direct: true });
  }
  try {
    await assertPublicHost(pageUrl);
    const candidates = new Set();
    const page = await fetch(pageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (OzzySports)', Accept: 'text/html,*/*' },
      redirect: 'follow',
    });
    const html = await page.text();
    for (const u of await findM3u8InText(html)) candidates.add(u);

    // NOS livestream pages don't inline the stream URL; the player asks a public
    // endpoint for it. Try that when the page is an NOS livestream/video page.
    const nosMatch = pageUrl.match(/nos\.nl\/(?:livestream|video|l|uitzendingen)\/(\d+)/i);
    if (nosMatch) {
      const id = nosMatch[1];
      const apiUrls = [
        `https://api.nos.nl/mobile/video/${id}/phone.json`,
        `https://api.nos.nl/nosapp/v3/items?ids[]=${id}`,
      ];
      for (const apiUrl of apiUrls) {
        try {
          const r = await fetch(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (OzzySports)' } });
          if (!r.ok) continue;
          for (const u of await findM3u8InText(await r.text())) candidates.add(u);
        } catch { /* try the next one */ }
      }
    }

    const streams = [...candidates];
    if (streams.length === 0) {
      return res.status(404).json({
        error: 'No HLS (.m3u8) stream found on that page. If you can find the .m3u8 URL yourself (browser dev tools → Network tab → filter "m3u8"), paste it directly.',
      });
    }
    res.json({ streams });
  } catch (err) {
    res.status(err.status || 502).json({ error: `Could not fetch that page: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// HLS proxy
// ---------------------------------------------------------------------------

function proxied(absUrl) {
  return `/api/proxy?url=${encodeURIComponent(absUrl)}`;
}

function rewritePlaylist(text, baseUrl) {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === '') return line;
      if (trimmed.startsWith('#')) {
        // Rewrite URI="..." attributes (keys, media renditions, i-frame playlists).
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxied(new URL(uri, baseUrl).href)}"`);
      }
      try {
        return proxied(new URL(trimmed, baseUrl).href);
      } catch {
        return line;
      }
    })
    .join('\n');
}

app.get('/api/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).send('Bad url');
  }
  try {
    await assertPublicHost(target);
    const upstream = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (OzzySports)', Referer: new URL(target).origin },
      redirect: 'follow',
    });
    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream responded ${upstream.status}`);
    }
    const ctype = upstream.headers.get('content-type') || '';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');

    const isPlaylist =
      /mpegurl|m3u8/i.test(ctype) || /\.m3u8(\?|$)/i.test(new URL(upstream.url || target).pathname + '?');
    if (isPlaylist || /\.m3u8(\?|$)/i.test(target)) {
      const text = await upstream.text();
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritePlaylist(text, upstream.url || target));
    }

    res.setHeader('Content-Type', ctype || 'application/octet-stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    res.status(err.status || 502).send(`Proxy error: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// Commentary generation
// ---------------------------------------------------------------------------

async function openai(pathname, body) {
  const r = await fetch(`${OPENAI_BASE_URL}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`OpenAI ${pathname} failed (${r.status}): ${detail.slice(0, 500)}`);
  }
  return r;
}

app.post('/api/commentary', async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not set on the server.' });
  }
  const { frames = [], history = [], sport = '', spice = 'cheeky', event = '' } = req.body || {};
  if (!Array.isArray(frames) || frames.length === 0) {
    return res.status(400).json({ error: 'Provide at least one frame (data URL).' });
  }
  if (!frames.every((f) => typeof f === 'string' && f.startsWith('data:image/'))) {
    return res.status(400).json({ error: 'Frames must be image data URLs.' });
  }

  try {
    const system = PERSONA.replace('{SPICE}', SPICE_LEVELS[spice] || SPICE_LEVELS.cheeky);
    const context = [
      sport ? `Sport / event: ${sport}` : '',
      event ? `Extra context from the viewer: ${event}` : '',
      history.length
        ? `Your recent lines (do NOT repeat these jokes or phrasings):\n${history
            .slice(-8)
            .map((h) => `- ${h}`)
            .join('\n')}`
        : 'This is your first line of the session — open with a quick, funny scene-setter.',
      `Here are ${frames.length} frames captured seconds apart, oldest first. Give me your next spoken line.`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const chatRes = await openai('/chat/completions', {
      model: VISION_MODEL,
      max_tokens: 160,
      temperature: 1.0,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: context },
            ...frames.slice(0, 4).map((f) => ({
              type: 'image_url',
              image_url: { url: f, detail: 'low' },
            })),
          ],
        },
      ],
    });
    const chat = await chatRes.json();
    const text = chat.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('Vision model returned no commentary text.');

    const ttsRes = await openai('/audio/speech', {
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text,
      instructions: TTS_INSTRUCTIONS,
      response_format: 'mp3',
      speed: 1.05,
    });
    const audio = Buffer.from(await ttsRes.arrayBuffer()).toString('base64');

    res.json({ text, audio, mime: 'audio/mpeg' });
  } catch (err) {
    console.error('[commentary]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    openaiKeyConfigured: Boolean(OPENAI_API_KEY),
    visionModel: VISION_MODEL,
    ttsModel: TTS_MODEL,
    ttsVoice: TTS_VOICE,
  });
});

app.listen(PORT, () => {
  console.log(`Ozzy Sports listening on http://localhost:${PORT}`);
  if (!OPENAI_API_KEY) {
    console.warn('WARNING: OPENAI_API_KEY is not set — commentary generation will fail.');
  }
});
