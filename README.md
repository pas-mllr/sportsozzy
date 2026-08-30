# Ozzy Sports 🎙️

An AI sports commentator for live streams. Point it at a live sport stream — like an
[NOS livestream](https://nos.nl/livestream/2614835-wk-mountainbike-met-van-der-poel) —
and it replaces the dry, boring official commentary with a live commentator that's half
Aussie larrikin, half weary observational stand-up, **while keeping the crowd and ambient
stadium sound** from the original broadcast.

Commentary is generated with OpenAI models: a vision model watches frames from the stream
and writes the next line in character, and the **`gpt-4o-mini-tts` speech model** speaks it
with a rowdy, off-the-cuff commentator delivery (via the TTS `instructions` parameter).

## How it works

```
 stream page URL ──▶ /api/resolve ──▶ .m3u8 URL
                                        │
        browser ◀── /api/proxy (CORS) ──┘        (hls.js plays it; canvas can capture frames)
           │
           ├─ every N seconds: capture 2–3 frames ──▶ POST /api/commentary
           │                                             │  vision model → commentary text
           │                                             │  gpt-4o-mini-tts → mp3
           │                       ◀─────────────────────┘
           │
           └─ Web Audio mixer:
                original stereo ──┐
                L − R (voice-cancelled ambience) ──┤──▶ crossfade ─▶ duck ─▶ 🔊
                Ozzy's TTS lines ──────────────────────────────────────────▶ 🔊
```

**Keeping the ambient sound:** broadcast commentators are mixed dead-centre, while crowd
and ambience are stereo. The player subtracts the right channel from the left
(karaoke-style centre-channel cancellation), which removes most of the original
commentator's voice but keeps the stereo atmosphere. A slider crossfades between the
original mix and the voice-cancelled mix, and the whole ambient bed automatically ducks
while Ozzy is talking.

## Setup

```bash
npm install
export OPENAI_API_KEY=sk-...
npm start
# open http://localhost:3210
```

Paste a stream URL, click **Find stream**, then click the **Watch with Ozzy Sports
commentary** link. That link (`/watch.html?src=…`) is shareable with anyone who can reach
your server. On the watch page, press **Start Ozzy Sports** (a click is required — browsers
demand a user gesture before audio can play).

### Configuration (env vars)

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required. |
| `OPENAI_VISION_MODEL` | `gpt-4o-mini` | Model that watches frames and writes commentary. |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | OpenAI speech model. |
| `OPENAI_TTS_VOICE` | `ash` | TTS voice (`ash`, `verse`, `ballad`, `coral`, …). |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Override for proxies/compatible APIs. |
| `PORT` | `3210` | HTTP port. |
| `APP_PASSWORD` | — | If set, the whole site requires this password (HTTP Basic auth, any username). Strongly recommended for public deployments — the commentary endpoint spends your OpenAI credits. |
| `ALLOW_PRIVATE_NETWORKS` | — | Set to `1` to let the resolver/proxy fetch private/localhost addresses (local development only; they are blocked by default to prevent SSRF). |

### In-player controls

- **Spice** — family friendly / cheeky (default) / full Ozzy (still no slurs, ever).
- **Original commentator removal** — 0% keeps the broadcast mix, 100% is full centre-channel cancellation.
- **Ambient / Ozzy volume**, **commentary pace** (seconds between lines), and a free-text
  **context** field ("WK mountainbike, Van der Poel is the favourite") that is fed to the model.

## Hosted version: ozzysports.live (GitHub Pages)

The `docs/` folder is a fully static build of Ozzy Sports that runs entirely in the
browser, deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to
`main`. Differences from the server version:

- Viewers paste their **own OpenAI API key** on the page. It is stored only in that
  browser's localStorage, and commentary/speech requests go directly from the browser to
  OpenAI — there is no server to hold a shared key.
- Streams play **straight from their CDN** (no proxy), so you need the direct `.m3u8`
  URL, and the CDN must allow cross-origin access for frame capture (most HLS CDNs do).
  Geo-blocked streams follow the viewer's own location; DRM streams don't work anywhere.
- **`docs/config.js`** holds the site defaults: a pre-loaded stream URL (note: NOS
  URLs carry signed tokens that expire — refresh the value when playback stops) and the
  default commentator context. With a default stream set, the watch page shows a single
  big **Play** button that starts stream + commentary in one press. Never put an API key
  in `config.js` — it's public. For one-click setup on a new device, use a private
  bookmark of the form `watch.html#key=sk-...`: the page stores the key in that browser
  and strips it from the address bar.

### One-time setup

1. Push to `main` (or run the "Deploy GitHub Pages" workflow manually). The workflow
   enables Pages itself (`enablement: true`) and the site appears at
   `https://pas-mllr.github.io/sportsozzy/`.
3. `docs/CNAME` already declares `ozzysports.live`. At your domain registrar, add:

   | Type | Name | Value |
   | --- | --- | --- |
   | A | `@` | `185.199.108.153` |
   | A | `@` | `185.199.109.153` |
   | A | `@` | `185.199.110.153` |
   | A | `@` | `185.199.111.153` |
   | AAAA | `@` | `2606:50c0:8000::153` |
   | AAAA | `@` | `2606:50c0:8001::153` |
   | AAAA | `@` | `2606:50c0:8002::153` |
   | AAAA | `@` | `2606:50c0:8003::153` |
   | CNAME | `www` | `pas-mllr.github.io` |

4. In **Settings → Pages**, confirm the custom domain shows `ozzysports.live`, wait for
   the DNS check and certificate, then tick **Enforce HTTPS**.

## Notes & limitations

- **Stream resolution**: `/api/resolve` scrapes the page for `.m3u8` URLs and knows a
  couple of NOS API endpoints. Some streams are geo-blocked (NOS streams generally require
  a Dutch IP) or DRM-protected — DRM streams can't be played or captured. If auto-resolve
  fails, grab the `.m3u8` URL from your browser's dev tools (Network tab, filter `m3u8`)
  and paste it directly.
- **Centre-channel cancellation** is a classic trick, not magic: it also removes anything
  else that is mono-centred, and won't work on mono streams. The crossfade slider lets you
  pick the best compromise per stream.
- The commentator sees still frames, not continuous video, so it's told to never invent
  scores, times, or names it can't read on screen.
- For personal use with streams you're allowed to watch. Nothing is re-broadcast or
  recorded; the stream plays in your own browser and only small snapshot frames are sent
  to OpenAI for commentary.
