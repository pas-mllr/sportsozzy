/* Ozzy Sports player: HLS playback, frame capture, commentary loop, audio mixing. */

const qs = new URLSearchParams(location.search);
const streamUrl = qs.get('src');
const $ = (id) => document.getElementById(id);

const video = $('video');
const transcript = $('transcript');
if (qs.get('sport')) $('sport').value = qs.get('sport');

function setStatus(text, live = false) {
  $('status').textContent = text;
  $('dot').classList.toggle('live', live);
}

function warn(msg) {
  $('warn').textContent = msg;
}

// ---------------------------------------------------------------------------
// Video: play the stream through our CORS proxy so canvas capture works.
// ---------------------------------------------------------------------------

if (!streamUrl) {
  setStatus('no stream URL — go back and pick one');
} else {
  const proxiedUrl = '/api/proxy?url=' + encodeURIComponent(streamUrl);
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({ liveSyncDurationCount: 3 });
    hls.loadSource(proxiedUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) {
        setStatus('stream error: ' + data.details);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = proxiedUrl; // Safari native HLS
  } else {
    setStatus('this browser cannot play HLS streams');
  }
  video.play().catch(() => setStatus('press play on the video to begin'));
  setStatus('stream loaded — original audio muted until you start Ozzy');
}

// ---------------------------------------------------------------------------
// Audio graph
//
//   video ─ source ─┬─ dryGain (original stereo) ──────────┐
//                   └─ splitter ─ L(+1)/R(−1) ─ wetGain ───┤─ ambientGain ─ duckGain ─┐
//                      (centre-channel voice removal)      │                          ├─ speakers
//   TTS buffers ───────────────────────────── ozzyGain ────────────────────────────── ┘
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
    warn('Cannot capture frames from this stream (CORS-tainted video). The commentator needs the stream to go through the proxy.');
    stop();
  }
}

// ---------------------------------------------------------------------------
// Commentary loop
// ---------------------------------------------------------------------------

let running = false;
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

function playCommentary(base64) {
  return new Promise((resolve, reject) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    ctx.decodeAudioData(bytes.buffer.slice(0), (buffer) => {
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
        const res = await fetch('/api/commentary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            frames: [...frameBuffer],
            history,
            sport: $('sport').value.trim(),
            spice: $('spice').value,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
        if (!running) break;
        history.push(data.text);
        if (history.length > 8) history.shift();
        const line = addLine(data.text);
        setStatus('Ozzy is talking', true);
        await playCommentary(data.audio);
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
  if (running) return;
  const health = await fetch('/api/health').then((r) => r.json()).catch(() => ({}));
  if (!health.openaiKeyConfigured) {
    warn('OPENAI_API_KEY is not configured on the server — set it and restart, or the commentator stays silent.');
  }
  buildAudioGraph();
  await ctx.resume();
  video.play().catch(() => {});
  running = true;
  $('start').disabled = true;
  $('stop').disabled = false;
  captureTimer = setInterval(captureFrame, 4000);
  captureFrame();
  commentaryCycle();
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
