/* Ozzy Sports static player (GitHub Pages build): HLS playback straight from the
 * stream CDN, frame capture, direct browser→OpenAI commentary, audio mixing.
 * The OpenAI key lives only in this browser's localStorage. */

const OPENAI_URL = 'https://api.openai.com/v1';
const VISION_MODEL = 'gpt-4o-mini';
const TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_VOICE = 'ash';

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

const qs = new URLSearchParams(location.search);
const cfg = window.OZZY_CONFIG || {};
const streamUrl = qs.get('src') || cfg.streamUrl || '';
const $ = (id) => document.getElementById(id);

const video = $('video');
const transcript = $('transcript');
$('sport').value = qs.get('sport') || cfg.sport || '';

// A private bookmark like  watch.html#key=sk-...  stores the key in this
// browser and immediately strips it from the address bar, so the key never
// appears in the public site or lingers in the URL.
try {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('key')) {
    localStorage.setItem('sportsozzy_openai_key', hash.get('key').trim());
    history.replaceState(null, '', location.pathname + location.search);
  }
} catch {}

try { $('apikey').value = localStorage.getItem('sportsozzy_openai_key') || ''; } catch {}
$('apikey').addEventListener('change', () => {
  try { localStorage.setItem('sportsozzy_openai_key', $('apikey').value.trim()); } catch {}
});

function setStatus(text, live = false) {
  $('status').textContent = text;
  $('dot').classList.toggle('live', live);
}

function warn(msg) {
  $('warn').textContent = msg;
}

// ---------------------------------------------------------------------------
// Video: played directly from the stream's CDN. Frame capture only works if
// the CDN sends CORS headers (crossorigin="anonymous" on the <video>).
// ---------------------------------------------------------------------------

if (!streamUrl) {
  setStatus('no stream URL — go back and pick one');
} else {
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({ liveSyncDurationCount: 3 });
    hls.loadSource(streamUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) {
        setStatus('stream error: ' + data.details);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          warn('If this keeps failing, the CDN may block cross-origin access or the stream may be geo-blocked. The self-hosted server version of Ozzy Sports proxies streams past this.');
          hls.startLoad();
        }
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = streamUrl; // Safari native HLS
  } else {
    setStatus('this browser cannot play HLS streams');
  }
  video.play().catch(() => setStatus('press play to begin'));
  setStatus('stream loaded — press play to start Ozzy');
  $('playOverlay').hidden = false;
}

// One press of play starts everything: the big overlay button, the Start
// button, or the native video controls all launch stream + commentary
// together. (Browsers require one user gesture before audio may play.)
$('playOverlay').addEventListener('click', start);
video.addEventListener('play', () => {
  // Ignore the programmatic muted autoplay on page load — only a real user
  // gesture may build the audio graph and start the commentator.
  if (!running && !starting && navigator.userActivation?.hasBeenActive) {
    if (getApiKey()) start();
    else warn('Enter your OpenAI API key (once) to get Ozzy talking — the stream plays without commentary until then.');
  }
});

// ---------------------------------------------------------------------------
// Audio graph (same design as the server build)
// ---------------------------------------------------------------------------

let ctx, duckGain, ozzyGain, ambientGain, dryGain, wetGain;

function buildAudioGraph() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  const source = ctx.createMediaElementSource(video);

  dryGain = ctx.createGain();
  source.connect(dryGain);

  // Karaoke-style centre removal: L − R cancels anything panned dead-centre
  // (the commentator's mic) while stereo ambience mostly survives.
  const splitter = ctx.createChannelSplitter(2);
  const invert = ctx.createGain();
  invert.gain.value = -1;
  const sum = ctx.createGain();
  sum.gain.value = 0.9;
  source.connect(splitter);
  splitter.connect(sum, 0); // L
  splitter.connect(invert, 1); // R
  invert.connect(sum); // L + (−R)
  wetGain = ctx.createGain();
  sum.connect(wetGain);

  ambientGain = ctx.createGain();
  dryGain.connect(ambientGain);
  wetGain.connect(ambientGain);

  duckGain = ctx.createGain();
  ambientGain.connect(duckGain);
  duckGain.connect(ctx.destination);

  ozzyGain = ctx.createGain();
  ozzyGain.connect(ctx.destination);

  applyMixControls();
  video.muted = false;
  video.volume = 1;
}

function applyMixControls() {
  if (!ctx) return;
  const k = Number($('karaoke').value) / 100;
  wetGain.gain.value = k;
  dryGain.gain.value = 1 - k;
  ambientGain.gain.value = Number($('ambientVol').value) / 100;
  ozzyGain.gain.value = Number($('ozzyVol').value) / 100;
  $('karaokeVal').textContent = `${$('karaoke').value}%`;
}

for (const id of ['karaoke', 'ambientVol', 'ozzyVol']) {
  $(id).addEventListener('input', applyMixControls);
}
$('pace').addEventListener('input', () => {
  $('paceVal').textContent = $('pace').value;
});

function duck(on) {
  if (!duckGain) return;
  const t = ctx.currentTime;
  duckGain.gain.cancelScheduledValues(t);
  duckGain.gain.setTargetAtTime(on ? 0.25 : 1.0, t, 0.15);
}

// ---------------------------------------------------------------------------
// Frame capture
// ---------------------------------------------------------------------------

const captureCanvas = document.createElement('canvas');
const frameBuffer = [];

function captureFrame() {
  if (video.videoWidth === 0) return;
  const w = 512;
  const h = Math.round((video.videoHeight / video.videoWidth) * w);
  captureCanvas.width = w;
  captureCanvas.height = h;
  captureCanvas.getContext('2d').drawImage(video, 0, 0, w, h);
  try {
    frameBuffer.push(captureCanvas.toDataURL('image/jpeg', 0.55));
    if (frameBuffer.length > 3) frameBuffer.shift();
  } catch (err) {
    warn('This stream\'s CDN does not allow cross-origin frame capture, so the commentator cannot see the video. The self-hosted server version of Ozzy Sports proxies the stream to fix this.');
    stop();
  }
}

// ---------------------------------------------------------------------------
// Commentary: browser → OpenAI directly
// ---------------------------------------------------------------------------

function getApiKey() {
  return $('apikey').value.trim();
}

async function openai(pathname, body) {
  const r = await fetch(`${OPENAI_URL}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    if (r.status === 401) throw new Error('OpenAI rejected the API key — check the key field.');
    const detail = await r.text().catch(() => '');
    throw new Error(`OpenAI ${pathname} failed (${r.status}): ${detail.slice(0, 300)}`);
  }
  return r;
}

async function generateCommentary(frames, history, sport, spice) {
  const system = PERSONA.replace('{SPICE}', SPICE_LEVELS[spice] || SPICE_LEVELS.cheeky);
  const context = [
    sport ? `Sport / event: ${sport}` : '',
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
          ...frames.slice(0, 4).map((f) => ({ type: 'image_url', image_url: { url: f, detail: 'low' } })),
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
  return { text, audio: await ttsRes.arrayBuffer() };
}

// ---------------------------------------------------------------------------
// Commentary loop
// ---------------------------------------------------------------------------

let running = false;
let starting = false;
let captureTimer = null;
const history = [];

function addLine(text) {
  if (transcript.querySelector('.hint')) transcript.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = text;
  p.className = 'speaking';
  transcript.prepend(p);
  while (transcript.children.length > 30) transcript.lastChild.remove();
  return p;
}

function playCommentary(arrayBuffer) {
  return new Promise((resolve, reject) => {
    ctx.decodeAudioData(arrayBuffer, (buffer) => {
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ozzyGain);
      duck(true);
      node.onended = () => {
        duck(false);
        resolve();
      };
      node.start();
    }, reject);
  });
}

async function commentaryCycle() {
  while (running) {
    const paceMs = Number($('pace').value) * 1000;
    const cycleStart = Date.now();
    try {
      if (frameBuffer.length === 0) captureFrame();
      if (frameBuffer.length === 0) {
        setStatus('waiting for video frames…', true);
      } else {
        setStatus('Ozzy is thinking…', true);
        const { text, audio } = await generateCommentary(
          [...frameBuffer],
          history,
          $('sport').value.trim(),
          $('spice').value
        );
        if (!running) break;
        history.push(text);
        if (history.length > 8) history.shift();
        const line = addLine(text);
        setStatus('Ozzy is talking', true);
        await playCommentary(audio);
        line.classList.remove('speaking');
        setStatus('listening to the game…', true);
      }
    } catch (err) {
      setStatus('error: ' + err.message, true);
      console.error(err);
    }
    // Keep the pace, measured from cycle start, with a small floor.
    const wait = Math.max(2000, paceMs - (Date.now() - cycleStart));
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function start() {
  if (running || starting) return;
  if (!getApiKey()) {
    warn('Enter your OpenAI API key first — it is stored only in this browser.');
    $('apikey').focus();
    return;
  }
  starting = true;
  try {
    warn('');
    $('playOverlay').hidden = true;
    buildAudioGraph();
    await ctx.resume();
    video.play().catch(() => {});
    running = true;
    $('start').disabled = true;
    $('stop').disabled = false;
    captureTimer = setInterval(captureFrame, 4000);
    captureFrame();
    commentaryCycle();
  } finally {
    starting = false;
  }
}

function stop() {
  running = false;
  clearInterval(captureTimer);
  $('start').disabled = false;
  $('stop').disabled = true;
  setStatus('commentator stopped — original mix still playing');
}

$('start').addEventListener('click', start);
$('stop').addEventListener('click', stop);
