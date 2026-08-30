# SportsOzzy 🎙️

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
# open http://localhost:3000
```

Paste a stream URL, click **Find stream**, then click the **Watch with SportsOzzy
commentary** link. That link (`/watch.html?src=…`) is shareable with anyone who can reach
your server. On the watch page, press **Start SportsOzzy** (a click is required — browsers
demand a user gesture before audio can play).

### Configuration (env vars)

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required. |
| `OPENAI_VISION_MODEL` | `gpt-4o-mini` | Model that watches frames and writes commentary. |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | OpenAI speech model. |
| `OPENAI_TTS_VOICE` | `ash` | TTS voice (`ash`, `verse`, `ballad`, `coral`, …). |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Override for proxies/compatible APIs. |
| `PORT` | `3000` | HTTP port. |

### In-player controls

- **Spice** — family friendly / cheeky (default) / full Ozzy (still no slurs, ever).
- **Original commentator removal** — 0% keeps the broadcast mix, 100% is full centre-channel cancellation.
- **Ambient / Ozzy volume**, **commentary pace** (seconds between lines), and a free-text
  **context** field ("WK mountainbike, Van der Poel is the favourite") that is fed to the model.

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
