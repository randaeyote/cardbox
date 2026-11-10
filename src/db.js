import { get, set, del, delMany, keys, getMany } from 'idb-keyval'
import { decodeScaled, canvasToWebp, canvasToJpeg, measureCorners } from './crop.js'

// The stored original that crops are re-rendered from. Large enough to keep detail for a 2400px crop, small enough
// that two per card don't bloat storage and backups. Also keeps under iOS's ~16.7 MP canvas limit.
const MAX_ORIGINAL_DIMENSION = 3000

// A card side is { image, original, edit }: the rendered JPEG shown everywhere, the uncropped photo it was rendered
// from, and the crop/rotate/enhance settings, so it can be re-edited without compounding quality loss.
// Cards saved before originals were kept use their image as the original.
export const sideOf = (card, name) =>
  card[name] && { image: card[name], original: card[`${name}Original`] ?? card[name], edit: card[`${name}Edit`] ?? null }
export const sideFields = (name, side) => ({
  [name]: side?.image ?? null, [`${name}Original`]: side?.original ?? null, [`${name}Edit`]: side?.edit ?? null,
})

const LEGACY_FIELDS = [['title', 'Title'], ['company', 'Company'], ['email', 'Email'], ['phone', 'Phone'], ['website', 'Website']]

// A card is in any number of collections (`collections`, names), with its own place in each that it was dragged into
// (`orders`: { name: position }, '' for the cards in none). Cards from before then had one `event` and one `order`.
// Cards from before the fields were cut to name/socials/event/note keep their old values as lines in the note.
export function migrateCard(card) {
  let next = card
  if (LEGACY_FIELDS.some(([key]) => key in next)) {
    const { title, company, email, phone, website, ...rest } = next
    const moved = LEGACY_FIELDS.filter(([key]) => card[key]).map(([key, label]) => `${label}: ${card[key]}`)
    next = { ...rest, socials: rest.socials ?? [], note: [rest.note, ...moved].filter(Boolean).join('\n') }
  }
  if (!('collections' in next)) {
    const { event, order, ...rest } = next
    next = { ...rest, collections: event ? [event] : [], orders: order != null ? { [event || '']: order } : {} }
  }
  return next
}

// Order within one collection ('' for the cards in none): cards never dragged there come first, newest first, so a
// new card shows at the top; then the cards in the order they were dragged into.
export const compareInGroup = (collection) => (a, b) => {
  const aPlace = a.orders?.[collection]
  const bPlace = b.orders?.[collection]
  if ((aPlace != null) !== (bPlace != null)) return aPlace != null ? 1 : -1
  return aPlace != null ? aPlace - bPlace : b.createdAt.localeCompare(a.createdAt)
}

export async function getCard(id) {
  const card = await get(`card:${id}`)
  return card && migrateCard(card)
}
// The cards that still exist, in order.
export const getCards = async (ids) => (await Promise.all(ids.map(getCard))).filter(Boolean)

const keysWithPrefix = async (prefix) => (await keys()).filter((key) => String(key).startsWith(prefix))
const cardIds = async () => (await keysWithPrefix('card:')).map((key) => String(key).slice('card:'.length))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function listCards() {
  const stored = await getMany(await keysWithPrefix('card:'))
  const cards = stored.map(migrateCard)
  const migrated = cards.filter((card, index) => card !== stored[index])
  if (migrated.length) await storeCards(migrated)
  return cards
}

// iOS Safari bug: a photo blob read from IndexedDB and written back (any save that only changed text, or Swap
// sides) leaves that photo unreadable for the rest of the visit, both the copy on screen and the one read back;
// it shows again only after a reload. Writing fresh in-memory copies avoids it. Costs one read of each photo per save.
export const IMAGE_FIELDS = ['front', 'frontOriginal', 'back', 'backOriginal']
async function withFreshImages(card) {
  const copy = { ...card }
  for (const field of IMAGE_FIELDS) {
    if (copy[field] instanceof Blob) copy[field] = new Blob([await copy[field].arrayBuffer()], { type: copy[field].type })
  }
  return copy
}

// Whether photos can be saved here. Private browsing in Safari (and every iOS browser, all WebKit) can't store a Blob
// in IndexedDB, and the save may never answer instead of failing, so a save that hasn't finished in time counts as no.
export async function canStorePhotos() {
  const check = set('storage-check', new Blob(['x'], { type: 'text/plain' })).then(() => del('storage-check')).then(() => true, () => false)
  return Promise.race([check, new Promise((resolve) => setTimeout(resolve, STORAGE_CHECK_MS, false))])
}
const STORAGE_CHECK_MS = 3000

// Sync keeps the copy of a card with the newest of these.
export const cardTime = (card) => card.updatedAt ?? card.createdAt

// As-is, keeping updatedAt: for sync, import and migration, which must not make a card look freshly edited.
// A card stored here again (synced back, imported, received) is no longer deleted here.
export async function storeCard(card) {
  await set(`card:${card.id}`, await withFreshImages(card))
  await del(`deleted:${card.id}`)
}
// One card at a time, so a big batch holds only one card's photos in memory at once.
async function storeCards(cards) {
  for (const card of cards) await storeCard(card)
}
// Settings → Storage: drops the uncropped photos kept for re-cropping. Each side's edit goes too (its corners, rotation
// and enhancement were measured on the original), all but the corner radius, which the cropped photo still shows.
// Not stamped as an edit: this saves space on this device only, so sync mustn't carry it to the others.
export async function removeOriginals(cards) {
  for (const card of cards.filter((card) => card.frontOriginal || card.backOriginal)) {
    const trimmed = { ...card }
    for (const side of ['front', 'back']) {
      if (!card[`${side}Original`]) continue
      trimmed[`${side}Original`] = null
      const radius = card[`${side}Edit`]?.radius
      trimmed[`${side}Edit`] = radius ? { radius } : null
    }
    await storeCard(trimmed)
  }
}
// A user's edit: stamped so sync knows it's the newest version.
export const saveCard = (card) => storeCard({ ...card, updatedAt: new Date().toISOString() })
export async function saveCards(cards) {
  const now = new Date().toISOString()
  await storeCards(cards.map((card) => ({ ...card, updatedAt: now })))
}

// A deleted card leaves a note of when, so sync can offer the delete to the other device instead of fetching the card
// back from it.
export async function deleteCard(id) {
  await delMany([`card:${id}`, `thumb:${id}:front`, `thumb:${id}:back`])
  await set(`deleted:${id}`, new Date().toISOString())
}
// Starting this device over: no notes, so a sync afterwards refills it rather than offering deletes elsewhere.
export const deleteAllCards = async () => delMany((await keys()).filter((key) => /^(card|thumb|deleted):/.test(String(key))))
// { [id]: ISO time } for the cards deleted here.
export async function listDeleted() {
  const noteKeys = await keysWithPrefix('deleted:')
  const times = await getMany(noteKeys)
  return Object.fromEntries(noteKeys.map((key, index) => [String(key).slice('deleted:'.length), times[index]]))
}

// List tiles show small copies of each side: decoding hundreds of full-size photos at once is what makes a big
// collection slow and, on iOS, reloads the page. Long side to stay sharp in a 240px tile on a 2x screen.
const THUMBNAIL_DIMENSION = 480
let thumbnailQueue = Promise.resolve()

// A side's thumbnail, made the first time it's needed. Stored apart from the card (thumb:<id>:<side>) so sync,
// backup and beam never carry it; each device makes its own. It records which photo it came from (size and type) and
// is remade when the photo changes. Made one at a time, so a fresh import doesn't decode every photo at once.
// Falls back to the photo itself if it can't be made.
export async function thumbnailFor(id, side, photo, transparent) {
  const key = `thumb:${id}:${side}`
  const source = `${photo.size}:${photo.type}`
  const stored = await get(key)
  if (stored?.source === source) return stored.blob
  const made = thumbnailQueue.then(async () => {
    const canvas = await decodeScaled(photo, THUMBNAIL_DIMENSION)
    // JPEG for cards: every phone encodes it natively and fast, where WebP on iOS goes through the slower WASM encoder.
    // Stickers need their transparency, so they stay WebP.
    const blob = await (transparent ? canvasToWebp(canvas, { quality: 0.8, transparent }) : canvasToJpeg(canvas, 0.8))
    await set(key, { source, blob })
    return blob
  })
  thumbnailQueue = made.catch(() => {})
  return made.catch(() => photo)
}
export const getLastBackup = () => get('meta:lastBackup')
export const setLastBackup = (isoString) => set('meta:lastBackup', isoString)

// Breather between cards, so converting a big collection doesn't make the app stutter.
const CONVERT_PAUSE_MS = 300

// Re-saves photos from before WebP (JPEG, sticker PNG) as WebP: about a quarter of the size, at a look that's hard to
// tell apart. Runs in the background one card at a time. Keeps updatedAt, so sync doesn't count it as an edit. Stops
// if WebP can't be made here (e.g. offline before the encoder was first fetched), to try again next launch.
// onCard runs after each card is converted. Returns how many cards changed.
export async function convertPhotosToWebp(onCard) {
  let changed = 0
  for (const id of await cardIds()) {
    const card = await getCard(id)
    const fields = IMAGE_FIELDS.filter((field) => card?.[field] instanceof Blob && card[field].type !== 'image/webp')
    if (!fields.length) continue
    const converted = {}
    for (const field of fields) {
      const webp = await canvasToWebp(await decodeScaled(card[field]), { transparent: card[field].type === 'image/png' })
      if (webp.type !== 'image/webp') return changed
      converted[field] = webp
    }
    // Re-read: the card may have been edited meanwhile; only photos still the same are replaced.
    const current = await getCard(id)
    if (!current) continue
    for (const field of fields) if (current[field]?.size === card[field].size) current[field] = converted[field]
    await storeCard(current)
    changed++
    await onCard?.()
    await pause(CONVERT_PAUSE_MS)
  }
  return changed
}

// Measures the corners (see measureCorners) of straight-cropped sides saved before corners were measured, from the
// saved photo. In the background like convertPhotosToWebp, and keeps updatedAt the same way.
export async function measureOldCorners(onCard) {
  const unmeasured = (card, name) => card?.kind !== 'sticker' && card?.[name] && card[`${name}Edit`]?.corners && !('radius' in card[`${name}Edit`])
  for (const id of await cardIds()) {
    const card = await getCard(id)
    const names = ['front', 'back'].filter((name) => unmeasured(card, name))
    if (!names.length) continue
    const radii = {}
    for (const name of names) {
      const bitmap = await createImageBitmap(card[name])
      radii[name] = measureCorners(bitmap)
      bitmap.close?.()
    }
    // Re-read: the card may have been edited meanwhile.
    const current = await getCard(id)
    if (!current) continue
    for (const name of names) {
      if (unmeasured(current, name) && current[name].size === card[name].size) current[`${name}Edit`] = { ...current[`${name}Edit`], radius: radii[name] }
    }
    await storeCard(current)
    await onCard?.()
    await pause(CONVERT_PAUSE_MS)
  }
}

// source: a Blob or canvas.
export async function normalizeOriginal(source) {
  return canvasToWebp(await decodeScaled(source, MAX_ORIGINAL_DIMENSION, { imageOrientation: 'from-image' }))
}

const EVENT_KEY = 'cardbox:lastEvent'
export function readLastEvent() {
  try {
    return localStorage.getItem(EVENT_KEY) || ''
  } catch {
    return ''
  }
}
export function writeLastEvent(event) {
  try {
    localStorage.setItem(EVENT_KEY, event)
  } catch {}
}
