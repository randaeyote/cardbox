// Serves the app's files, plus /turn: short-lived passwords for the TURN relay on the home server (coturn with
// use-auth-secret), for phones that can't connect directly. The shared secret stays here (TURN_SECRET) and on the
// relay, never in the app.

// How long a password works. A relay connection must be set up and refreshed within it, so a sync has an hour.
const TTL_SECONDS = 3600

// coturn's time-limited credentials: username "<expiry>:<label>", password base64(HMAC-SHA1(secret, username)).
export async function turnCredentials(secret, now = Date.now()) {
  const username = `${Math.floor(now / 1000) + TTL_SECONDS}:cardbox`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username))
  return { username, credential: btoa(String.fromCharCode(...new Uint8Array(signature))) }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url)
    if (pathname !== '/turn') return env.ASSETS.fetch(request)
    // Only for Cardbox's own pages: other sites' scripts can't get relay passwords. (Anything outside a browser can
    // still ask; the passwords expire, and the relay never forwards into private networks.)
    const site = request.headers.get('Sec-Fetch-Site')
    if (site && site !== 'same-origin') return new Response('Forbidden', { status: 403 })
    if (!env.TURN_SECRET || !env.TURN_HOST) return new Response('Relay not configured', { status: 503 })
    const { username, credential } = await turnCredentials(env.TURN_SECRET)
    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: [`turn:${env.TURN_HOST}:3478?transport=udp`, `turn:${env.TURN_HOST}:3478?transport=tcp`], username, credential },
    ]
    return Response.json({ iceServers }, { headers: { 'Cache-Control': 'no-store' } })
  },
}
