import { IMAGE_FIELDS, listCards, getCard, cardTime, storeCard } from './db.js'

// Peer IDs on the public PeerJS relay are global, so ours carry a prefix. The relay only passes connection details
// between the two devices; cards travel directly between them (or through our TURN relay, encrypted, when a direct
// path is blocked, as between Wi-Fi and mobile data) and are never stored anywhere but on the devices.
const PEER_PREFIX = 'cardbox-sync-'
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
// Bumped whenever the exchange or merge rules change, so two devices on different versions refuse to sync rather
// than each following different rules.
const PROTOCOL_VERSION = 7
// Cards requested at once: enough to keep the connection busy between round trips, few enough to bound memory.
const CARDS_IN_FLIGHT = 4
// From a device connecting until both have proved the pairing. Without it, a connection that never opens (no direct
// path and the TURN relay unreachable) or a device that never answers (an old version) leaves both on Connecting.
const CONNECT_TIMEOUT_MS = 20000
const RELAY_TIMEOUT_MS = 5000

const newSyncCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(CODE_LENGTH)), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('')
// The code finds the other device on the relay; the secret, which only travels inside the QR link (after the '#', so
// never to a server), proves each device is the one that showed or scanned it. 16 random bytes, base64url.
export const newPairing = () => ({
  code: newSyncCode(),
  secret: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
})
const linkTo = (kind, { code, secret }) => `${location.origin}${location.pathname}#${kind}/${code}.${secret}`
export const syncLink = (pairing) => linkTo('sync', pairing)
// For handing over one card: opens the other phone's Receive screen, which only takes, never shares.
export const receiveLink = (pairing) => linkTo('receive', pairing)
// { code, secret } from a link, or from the part of one after '#sync/' or '#receive/'; null for anything else.
export function parsePairing(text) {
  const [, code, secret] = text.match(/([A-Z0-9]{6})\.([\w-]{22})$/) ?? []
  return code && [...code].every((char) => CODE_ALPHABET.includes(char)) ? { code, secret } : null
}
export const parseSyncLink = (text) => (text.includes('#sync/') ? parsePairing(text) : null)
export const parseReceiveLink = (text) => (text.includes('#receive/') ? parsePairing(text) : null)

// Proof that the device signing knows the secret and sees this very connection: the DTLS certificate fingerprints at
// both ends, which WebRTC checks the encrypted connection against. A relay sitting in the middle would hold two
// connections with different fingerprints, so it could neither make a proof nor pass one on. The signer's role is in
// it so a proof can't be bounced back to the device that made it.
export async function pairingProof(secret, role, ourFingerprint, theirFingerprint) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${role}|${ourFingerprint}|${theirFingerprint}`))
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
const fingerprintOf = (description) => description?.sdp.match(/a=fingerprint:(\S+ \S+)/)?.[1] ?? ''

// A card's content apart from its photos' bytes, to tell two copies with the same edit time apart.
export const contentOf = (card) => JSON.stringify([
  card.name ?? '', card.socials ?? [], card.collections ?? [], card.note ?? '', card.orders ?? {}, card.size ?? null,
  card.frontEdit ?? null, card.backEdit ?? null, IMAGE_FIELDS.map((field) => card[field]?.size ?? 0),
])

// Which of the other device's cards this device should fetch: those missing here or edited more recently there.
// Sync never deletes, so a card deleted on one device comes back from the other. Copies with the same time but
// different content (cards edited before edit times were recorded) are fetched both ways and merged with mergeTied.
// Each side is { [id]: { time, content } } with ISO times.
export function planSync(local, remote) {
  return Object.keys(remote).filter((id) => {
    const theirs = remote[id]
    const ours = local[id]
    return !ours || theirs.time > ours.time || (theirs.time === ours.time && theirs.content !== ours.content)
  })
}

// Combines two copies of a card with the same edit time, so neither loses anything: all socials and collections, and
// for each text field the filled-in (or longer) value. Gives the same result whichever copy is `a`, so both devices agree.
export function mergeTied(a, b) {
  const [first, second] = contentOf(a) <= contentOf(b) ? [a, b] : [b, a]
  const pick = (x = '', y = '') => (y.length > x.length ? y : x)
  const merged = {
    ...first,
    name: pick(first.name, second.name),
    collections: [...new Set([...(first.collections ?? []), ...(second.collections ?? [])])].sort(),
    note: pick(first.note, second.note),
    socials: [...new Set([...(first.socials ?? []), ...(second.socials ?? [])])].sort(),
    orders: { ...second.orders, ...first.orders },
  }
  for (const field of [...IMAGE_FIELDS, 'frontEdit', 'backEdit']) merged[field] = first[field] ?? second[field] ?? null
  return merged
}

// offer: the ids this device shares (null = all).
async function localCards(offer = null) {
  const cards = (await listCards()).filter((card) => !offer || offer.includes(card.id))
  return Object.fromEntries(cards.map((card) => [card.id, { time: cardTime(card), content: contentOf(card) }]))
}

// The sizes of a card's photos, sent with a request so the other device can skip photos we already have.
const photoSizes = (card) => Object.fromEntries(IMAGE_FIELDS.map((field) => [field, card?.[field]?.size ?? null]))

// Photos go over the wire as { type, data: ArrayBuffer }, or { same: true } when the requester's copy is the same
// size (photos are only ever replaced by a re-encode, which changes the size). Most syncs then move only text.
async function packCard(card, have) {
  const packed = { ...card }
  for (const field of IMAGE_FIELDS) {
    if (!card[field]) continue
    packed[field] = have?.[field] === card[field].size
      ? { same: true }
      : { type: card[field].type, data: await card[field].arrayBuffer() }
  }
  return packed
}
function unpackCard(packed, ours) {
  const card = { ...packed }
  for (const field of IMAGE_FIELDS) {
    if (packed[field]) card[field] = packed[field].same ? ours[field] : new Blob([packed[field].data], { type: packed[field].type })
  }
  return card
}

// Both devices run the same exchange: send their cards' edit times, pull the cards they need a few at a time, then
// say done. Resolves when both are done with { received, sent, ids } (ids: the cards received).
// offer limits which cards this side lists and hands over (null = all); fetch false takes nothing. Handing one card to
// someone is offer [id] + fetch false on the sender, offer [] on the receiver, so neither learns the other's other cards.
// It opens with each side proving it holds the pairing secret (see pairingProof); nothing else is sent until the other
// side's proof checks out.
function exchange(connection, onProgress, { role, secret, onVerified, offer = null, fetch = true }) {
  return new Promise((resolve, reject) => {
    const counts = { received: 0, sent: 0, ids: [] }
    let queue = null
    let total = 0
    let inFlight = 0
    let doneHere = false
    let doneThere = false
    const send = (message) => connection.send(message)
    const finishIfBoth = () => doneHere && doneThere && resolve(counts)
    const requestMore = async () => {
      onProgress({ received: counts.received, total })
      while (inFlight < CARDS_IN_FLIGHT && queue.length) {
        const id = queue.shift()
        inFlight++
        send({ type: 'want', id, have: photoSizes(await getCard(id)) })
      }
      if (inFlight || queue.length || doneHere) return
      doneHere = true
      send({ type: 'done' })
      finishIfBoth()
    }
    const { localDescription, remoteDescription } = connection.peerConnection
    const ours = fingerprintOf(localDescription)
    const theirs = fingerprintOf(remoteDescription)
    let verified = false
    const handle = async (message) => {
      if (!verified) {
        const expected = await pairingProof(secret, role === 'host' ? 'guest' : 'host', theirs, ours)
        if (!ours || !theirs || message.type !== 'proof' || message.proof !== expected) {
          const error = new Error('pairing failed')
          error.type = 'pairing-failed'
          throw error
        }
        verified = true
        onVerified()
        await localCards(offer).then((cards) => send({ type: 'state', cards, version: PROTOCOL_VERSION }))
      } else if (message.type === 'state') {
        if (message.version !== PROTOCOL_VERSION) {
          const error = new Error('version mismatch')
          error.type = 'version-mismatch'
          throw error
        }
        const wanted = fetch ? planSync(await localCards(), message.cards) : []
        queue = wanted
        total = wanted.length
        await requestMore()
      } else if (message.type === 'want') {
        const card = !offer || offer.includes(message.id) ? await getCard(message.id) : null
        send({ type: 'card', id: message.id, card: card ? await packCard(card, message.have) : null })
        if (card) counts.sent++
      } else if (message.type === 'card') {
        inFlight--
        if (message.card) {
          const ours = await getCard(message.id)
          const theirs = unpackCard(message.card, ours)
          const next = ours && cardTime(ours) === cardTime(theirs) ? mergeTied(ours, theirs) : theirs
          if (!ours || contentOf(next) !== contentOf(ours)) {
            await storeCard(next)
            counts.received++
            counts.ids.push(message.id)
          }
        }
        await requestMore()
      } else if (message.type === 'done') {
        doneThere = true
        finishIfBoth()
      }
    }
    // Messages are handled strictly in order, since each step reads what the last one stored.
    let chain = Promise.resolve()
    connection.on('data', (message) => { chain = chain.then(() => handle(message)).catch(reject) })
    // The other device hangs up once it's done; let our queued messages finish before judging.
    connection.on('close', () => chain.then(() => (doneHere && doneThere ? resolve(counts) : reject(new Error('closed')))))
    connection.on('error', reject)
    pairingProof(secret, role, ours, theirs).then((proof) => send({ type: 'proof', proof }), reject)
  })
}

// Connection servers including our TURN relay, with passwords good for an hour (from the Worker's /turn), or null to
// go without it (PeerJS's defaults, which need a direct path) when they can't be had: offline, or a dev server.
async function relayServers() {
  try {
    const response = await fetch('/turn', { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) })
    return response.ok ? (await response.json()).iceServers : null
  } catch {
    return null
  }
}

// Starts a sync session. As host it waits for the other device to connect with the pairing's code; as guest it
// connects to it.
// Returns { done: Promise<counts>, close() }. Errors carry PeerJS's `type` (e.g. 'peer-unavailable', 'network').
// offer / fetch: see exchange.
export async function startSync({ role, pairing: { code, secret }, onStatus, onProgress, offer, fetch }) {
  const [{ Peer }, iceServers] = await Promise.all([import('peerjs'), relayServers()])
  const options = iceServers ? { config: { iceServers } } : {}
  const peer = role === 'host' ? new Peer(PEER_PREFIX + code, options) : new Peer(options)
  const done = new Promise((resolve, reject) => {
    peer.on('error', reject)
    const run = (connection) => {
      onStatus('syncing')
      const timer = setTimeout(() => {
        const error = new Error('timed out')
        error.type = 'timeout'
        reject(error)
      }, CONNECT_TIMEOUT_MS)
      const onVerified = () => clearTimeout(timer)
      const begin = () => exchange(connection, onProgress, { role, secret, onVerified, offer, fetch }).then(resolve, reject)
      if (connection.open) begin()
      else connection.on('open', begin)
    }
    if (role === 'host') {
      peer.on('open', () => onStatus('waiting'))
      // Only the first device to connect syncs; the code is single-use.
      peer.once('connection', run)
    } else {
      peer.on('open', () => run(peer.connect(PEER_PREFIX + code, { reliable: true })))
    }
  })
  // Leave time for the last message to flush before tearing down.
  done.finally(() => setTimeout(() => peer.destroy(), 1000)).catch(() => {})
  return { done, close: () => peer.destroy() }
}
