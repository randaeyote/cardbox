import { IMAGE_FIELDS, listCards, listDeleted, getCard, cardTime, storeCard } from './db.js'
import { shuffle } from './collage.js'

// Peer IDs on the public PeerJS relay are global, so ours carry a prefix. The relay only passes connection details
// between the two devices; cards travel directly between them (or through our TURN relay, encrypted, when a direct
// path is blocked, as between Wi-Fi and mobile data) and are never stored anywhere but on the devices.
const PEER_PREFIX = 'cardbox-sync-'
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
// Bumped whenever the exchange or merge rules change, so two devices on different versions refuse to sync rather
// than each following different rules.
const PROTOCOL_VERSION = 8
// Cards requested at once: enough to keep the connection busy between round trips, few enough to bound memory.
const CARDS_IN_FLIGHT = 4
// From a device connecting until both have proved the pairing. Without it, a connection that never opens (no direct
// path and the TURN relay unreachable) or a device that never answers (an old version) leaves both on Connecting.
const CONNECT_TIMEOUT_MS = 20000
const RELAY_TIMEOUT_MS = 5000
// A host still waiting that loses the pairing server (iOS cuts it while the browser is in the background, e.g. to paste
// the link elsewhere) signs in again under the same code once it's back in view, so the link keeps working. The server
// may hold the old sign-in a little while: retry this often, this many times.
export const RELAY_ERRORS = ['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected']
const RELISTEN_ERRORS = [...RELAY_ERRORS, 'unavailable-id']
const RELISTEN_DELAY_MS = 2000
// Enough to outlast the server holding a sign-in after the page was cleared from memory without signing out.
const RELISTEN_TRIES = 30
const whenVisible = () => new Promise((resolve) => {
  if (document.visibilityState === 'visible') return resolve()
  const seen = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', seen); resolve() } }
  document.addEventListener('visibilitychange', seen)
})

const newSyncCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(CODE_LENGTH)), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('')
// The code finds the other device on the relay; the secret, which only travels inside the QR link (after the '#', so
// never to a server), proves each device is the one that showed or scanned it. 16 random bytes, base64url.
export const newPairing = () => ({
  code: newSyncCode(),
  secret: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
})
// The QR link on screen while waiting: { kind: 'send' | 'sync', pairing, ids?, pack? }. Kept so that if iOS clears the
// page from memory while the user is in another app (sharing the link, say), it reopens showing the same link.
const SHOWN_KEY = 'shownPairing'
// Past this, reopening the app shouldn't land on an old QR screen.
const SHOWN_MAX_MS = 60 * 60 * 1000
export const rememberShown = (shown) => localStorage.setItem(SHOWN_KEY, JSON.stringify({ ...shown, at: Date.now() }))
export const forgetShown = () => localStorage.removeItem(SHOWN_KEY)
export function shownPairing() {
  try {
    const shown = JSON.parse(localStorage.getItem(SHOWN_KEY))
    return shown && Date.now() - shown.at < SHOWN_MAX_MS ? shown : null
  } catch {
    return null
  }
}
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
// Originals, and the crop details measured on them, are left out: Settings → Storage can remove them on one device
// only, and that mustn't make the copies differ.
export const contentOf = (card) => JSON.stringify([
  card.name ?? '', card.socials ?? [], card.collections ?? [], card.note ?? '', card.orders ?? {}, card.size ?? null,
  card.frontEdit?.radius ?? null, card.backEdit?.radius ?? null, (card.front?.size ?? 0), (card.back?.size ?? 0),
])

// Which of the other device's cards this device should fetch: those missing here or edited more recently there, but
// not those deleted here since they were last edited. Copies with the same time but different content (cards edited
// before edit times were recorded) are fetched both ways and merged with mergeTied.
// Each side is { [id]: { time, content } } with ISO times; deleted: { [id]: time } for the cards deleted here.
export function planSync(local, remote, deleted = {}) {
  return Object.keys(remote).filter((id) => {
    const theirs = remote[id]
    const ours = local[id]
    if (!ours) return !(deleted[id] >= theirs.time)
    return theirs.time > ours.time || (theirs.time === ours.time && theirs.content !== ours.content)
  })
}

// The cards here that the other device deleted after they were last edited. Sync never deletes them itself: they're
// listed for the user to confirm (see SyncScreen). An edit after the delete wins, and the card goes back instead.
// theirDeleted: the other device's { [id]: time } of deletes.
// The cards here with originals that the other device has removed (Settings → Storage). Sync never removes them
// itself: they're listed for the user to confirm, like deletes. A device on an older Cardbox doesn't say, so its cards
// are never listed.
export const planOriginals = (local, remote) => Object.keys(remote).filter((id) => local[id]?.originals && remote[id].originals === false)
export const planDeletes = (local, theirDeleted) => Object.keys(theirDeleted).filter((id) => local[id] && theirDeleted[id] > local[id].time)

// Combines two copies of a card with the same edit time, so neither loses anything: all socials and collections, and
// for each text field the filled-in (or longer) value. Gives the same result whichever copy is `a`, so both devices agree.
// A received card never takes away an original this device still has (Settings → Storage removes them on one device
// only). Kept with its crop details if the cropped photo is the same one; if the sender changed it (recropped from its
// cropped photo), those details no longer fit, so only the corner radius is kept with it.
export function keepOriginals(received, ours) {
  if (!ours) return received
  const kept = { ...received }
  for (const side of ['front', 'back']) {
    const original = ours[`${side}Original`]
    if (!original || received[`${side}Original`]) continue
    kept[`${side}Original`] = original
    const radius = received[`${side}Edit`]?.radius
    kept[`${side}Edit`] = received[side]?.size === ours[side]?.size ? ours[`${side}Edit`] : radius ? { radius } : null
  }
  return kept
}

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
  return Object.fromEntries(cards.map((card) => [card.id, { time: cardTime(card), content: contentOf(card), originals: !!(card.frontOriginal || card.backOriginal) }]))
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

// A pack's cards: PACK_SIZE ids at random, each at most once while there are enough; a smaller collection gives every
// card, then repeats random ones to fill the pack.
export const PACK_SIZE = 8
export function packIds(ids, random = Math.random) {
  const pick = () => ids[Math.floor(random() * ids.length)]
  const shuffled = shuffle([...ids], random)
  return [...shuffled.slice(0, PACK_SIZE), ...Array.from({ length: Math.max(0, PACK_SIZE - ids.length) }, pick)]
}

// Both devices run the same exchange: send their cards' edit times and deletes, pull the cards they need a few at a
// time, then say done. Resolves when both are done with { received, sent, ids, deleted, originals, pack } (ids: the
// cards received; deleted: the cards here the other device deleted, still to confirm; originals: the cards here whose
// originals the other device removed, also to confirm; pack: the other device's, as below).
// pack, sending one: { name, ids } (ids in pack order, repeats and all), passed on for the receiver to open; offer
// should be its ids.
// offer limits which cards this side lists and hands over (null = all); fetch false takes nothing. Handing one card to
// someone is offer [id] + fetch false on the sender, offer [] on the receiver, so neither learns the other's other cards.
// It opens with each side proving it holds the pairing secret (see pairingProof); nothing else is sent until the other
// side's proof checks out.
function exchange(connection, onProgress, { role, secret, onVerified, offer = null, fetch = true, pack = null }) {
  return new Promise((resolve, reject) => {
    const counts = { received: 0, sent: 0, ids: [], deleted: [], originals: [], pack: null }
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
          throw Object.assign(new Error('pairing failed'), { type: 'pairing-failed' })
        }
        verified = true
        onVerified()
        // Deletes only travel in a full sync, not when handing over one card.
        send({ type: 'state', cards: await localCards(offer), deleted: offer ? {} : await listDeleted(), pack, version: PROTOCOL_VERSION })
      } else if (message.type === 'state') {
        if (message.version !== PROTOCOL_VERSION) {
          throw Object.assign(new Error('version mismatch'), { type: 'version-mismatch' })
        }
        const here = await localCards()
        // A card handed over (offer set here too) is taken even if it was deleted here: only a full sync keeps it gone.
        const wanted = fetch ? planSync(here, message.cards, offer ? {} : await listDeleted()) : []
        if (fetch) counts.deleted = planDeletes(here, message.deleted ?? {})
        // Like deletes, only in a full sync: handing one card over isn't a say in what this device keeps.
        if (fetch && !offer) counts.originals = planOriginals(here, message.cards)
        if (fetch) counts.pack = message.pack ?? null
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
          const next = keepOriginals(ours && cardTime(ours) === cardTime(theirs) ? mergeTied(ours, theirs) : theirs, ours)
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
// offer / fetch / pack: see exchange. resume: hosting again under a remembered code, which the server may still hold.
export async function startSync({ role, pairing: { code, secret }, onStatus = () => {}, onProgress = () => {}, offer, fetch, pack, resume = false }) {
  const [{ Peer }, iceServers] = await Promise.all([import('peerjs'), relayServers()])
  const options = iceServers ? { config: { iceServers } } : {}
  let peer
  let closed = false
  const done = new Promise((resolve, reject) => {
    let connected = false
    const run = (connection) => {
      connected = true
      onStatus('syncing')
      const timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { type: 'timeout' })), CONNECT_TIMEOUT_MS)
      const onVerified = () => clearTimeout(timer)
      const begin = () => exchange(connection, onProgress, { role, secret, onVerified, offer, fetch, pack }).then(resolve, reject)
      if (connection.open) begin()
      else connection.on('open', begin)
    }
    const listen = (tries) => {
      peer = new Peer(PEER_PREFIX + code, options)
      let lostAlready = false
      peer.on('open', () => onStatus('waiting'))
      // Only the first device to connect syncs; the code is single-use.
      peer.once('connection', run)
      peer.on('error', async (error) => {
        // One loss can raise several errors.
        if (lostAlready) return
        // On the first try, 'unavailable-id' is someone else's code: the caller picks another.
        const lost = RELISTEN_ERRORS.includes(error.type) && (tries > 0 || error.type !== 'unavailable-id')
        if (connected || closed || !lost || tries >= RELISTEN_TRIES) return reject(error)
        lostAlready = true
        const lostPeer = peer
        setTimeout(() => lostPeer.destroy())
        await whenVisible()
        setTimeout(() => closed || listen(tries + 1), tries ? RELISTEN_DELAY_MS : 0)
      })
    }
    if (role === 'host') listen(resume ? 1 : 0)
    else {
      peer = new Peer(options)
      peer.on('error', reject)
      peer.on('open', () => run(peer.connect(PEER_PREFIX + code, { reliable: true })))
    }
  })
  // Leave time for the last message to flush before tearing down.
  done.finally(() => setTimeout(() => peer.destroy(), 1000)).catch(() => {})
  return { done, close: () => { closed = true; peer.destroy() } }
}
