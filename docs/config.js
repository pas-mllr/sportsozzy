/* Ozzy Sports site defaults.
 *
 * This file is PUBLIC (it ships with the website and lives in a public repo).
 * NEVER put an OpenAI API key or any other secret in here — keys go in the
 * browser's own storage via the key field on the page, or a private bookmark
 * like  https://ozzysports.live/watch.html#key=sk-...  (the page stores the
 * key locally and immediately strips it from the address bar).
 */
window.OZZY_CONFIG = {
  // Default stream, played when no ?src= is given.
  //
  // NOTE: NOS/StreamGate URLs carry a signed token that EXPIRES — this one on
  // 2026-08-31 at 14:12 UTC (16:12 CEST). When playback stops working, grab a
  // fresh URL (open the stream on nos.nl → F12 → Network tab → filter "m3u8"
  // → copy the URL) and replace the value below.
  streamUrl:
    'https://npo-nl-ams-p20-am5.cdn.streamgate.nl/eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3ODgxODU1NTIsInVyaSI6IlwvbGl2ZVwvbnBvXC91XzNfNFwvbm9zXC9ub2RybVwvaGxzX3VuZW5jcnlwdGVkXC9ub3NfZXZlbnQxXC8wXC8wXC8wXC9ub3NfZXZlbnQxLmlzbWwiLCJjbGllbnRfaXAiOiIxNDYuNzUuMTYyLjYxIiwidmlld2VyIjoibm9zLXJ1c3RvcGhlciIsInJpZCI6IjJlMjA3ZGIifQ.LphcWaX2m4uNv8O-Ld19Of2UtUbf5y7Bda8gIAf_rHE/live/npo/u_3_4/nos/nodrm/hls_unencrypted/nos_event1/0/0/0/nos_event1.isml/nos_event1-audio_1=256000-video=3499968.m3u8',

  // Default context fed to the commentator.
  sport: 'WK mountainbike, Van der Poel is the favourite',
};
