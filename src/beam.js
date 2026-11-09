import { scaledCanvas, decodeScaled, canvasToJpeg, canvasToWebp } from './crop.js'
import { seededRandom } from './collage.js'

// Sends one card or sticker to another phone as an endless stream of QR codes ("beaming"): no network needed.
// The card is packed small (photos shrunk and re-encoded), cut into blocks, and sent as a fountain code: the plain
// blocks first, then random XOR mixes of them (a random linear code over GF(2)). The receiver solves for the blocks
// by Gaussian elimination, so any frames, in any order, that add up to the block count (plus one or two) rebuild
// the card; a missed frame never means waiting for it to come round again.

// Photos are shrunk to this long side: sharp enough to zoom into small print, at about 25 KB a side (a two-sided card
// beams in about 15 s). 1200 adds a third to that for little visible gain on a phone; 480 looks soft zoomed in.
const PHOTO_DIMENSION = 1000
const PHOTO_QUALITY = 0.6
// Bytes of card data per QR code. With the 14-byte header and low error correction this is a version ~22 code
// (105 modules), which a phone camera reads off another phone's screen at arm's length.
export const BLOCK_BYTES = 800
const MASK_SNAP = 24
const MAGIC = 0xcb
const FORMAT = 2
// magic, format, transfer id (2), block count (2), byte length (4), seed (4).
const HEADER_BYTES = 14

// Fields that travel; photos go separately. The id travels too, so beaming the same card twice updates it.
const TEXT_FIELDS = ['id', 'kind', 'name', 'socials', 'collections', 'note', 'size', 'createdAt']

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// Layout: 4-byte JSON length, JSON ({ card, parts: [{ name, type, length }] }), then each part's bytes in order.
export function joinParts(json, parts) {
  const head = encoder.encode(JSON.stringify({ ...json, parts: parts.map(({ name, type, bytes }) => ({ name, type, length: bytes.length })) }))
  const out = new Uint8Array(4 + head.length + parts.reduce((sum, part) => sum + part.bytes.length, 0))
  new DataView(out.buffer).setUint32(0, head.length)
  out.set(head, 4)
  let offset = 4 + head.length
  for (const part of parts) {
    out.set(part.bytes, offset)
    offset += part.bytes.length
  }
  return out
}

export function splitParts(bytes) {
  const headLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0)
  const json = JSON.parse(decoder.decode(bytes.subarray(4, 4 + headLength)))
  let offset = 4 + headLength
  const parts = {}
  for (const { name, type, length } of json.parts) {
    parts[name] = { type, bytes: bytes.subarray(offset, offset + length) }
    offset += length
  }
  return { ...json, parts }
}

// Which blocks a frame mixes. Seeds below the block count are the plain blocks themselves; the rest take each
// block with even odds, which is what lets almost any set of frames be solved.
export function blocksFor(seed, count) {
  if (seed < count) return [seed]
  const next = seededRandom(seed)
  const chosen = []
  for (let index = 0; index < count; index++) if (next() < 0.5) chosen.push(index)
  return chosen.length ? chosen : [seed % count]
}

const xorInto = (target, source) => {
  for (let i = 0; i < target.length; i++) target[i] ^= source[i]
}

// Endless frames for one packed card: the plain blocks once, then fresh random mixes, each with its own seed.
export function frameStream(bytes) {
  const id = Math.floor(Math.random() * 0x10000)
  const count = Math.ceil(bytes.length / BLOCK_BYTES)
  const blocks = Array.from({ length: count }, (_, i) => {
    const block = new Uint8Array(BLOCK_BYTES)
    block.set(bytes.subarray(i * BLOCK_BYTES, (i + 1) * BLOCK_BYTES))
    return block
  })
  let seed = 0
  return {
    count,
    next() {
      const frame = new Uint8Array(HEADER_BYTES + BLOCK_BYTES)
      const view = new DataView(frame.buffer)
      view.setUint8(0, MAGIC)
      view.setUint8(1, FORMAT)
      view.setUint16(2, id)
      view.setUint16(4, count)
      view.setUint32(6, bytes.length)
      view.setUint32(10, seed)
      const data = frame.subarray(HEADER_BYTES)
      for (const index of blocksFor(seed, count)) xorInto(data, blocks[index])
      seed++
      return frame
    },
  }
}

// Rebuilds a card from frames as they're scanned, by Gaussian elimination: each frame is an equation (which blocks
// it XORs together, and the result), reduced against the ones kept so far; one that adds nothing new is dropped.
// Once there are as many independent equations as blocks, back-substitution gives every block. add() returns false
// for anything that isn't a frame of a beam; the first frame seen picks the beam, and frames from any other one are
// dropped.
export function frameCollector() {
  let id = null
  let length = 0
  let count = 0
  // rows[i]: the kept equation whose lowest block is i, as { blocks: Uint8Array of 0/1 per block, data }.
  let rows = []
  let rank = 0

  return {
    add(frame) {
      if (frame.length < HEADER_BYTES) return false
      const view = new DataView(frame.buffer, frame.byteOffset, frame.length)
      if (view.getUint8(0) !== MAGIC || view.getUint8(1) !== FORMAT) return false
      if (id === null) {
        id = view.getUint16(2)
        count = view.getUint16(4)
        length = view.getUint32(6)
        rows = new Array(count).fill(null)
      }
      if (view.getUint16(2) !== id) return false
      if (rank === count) return true
      const blocks = new Uint8Array(count)
      for (const index of blocksFor(view.getUint32(10), count)) blocks[index] = 1
      const data = frame.slice(HEADER_BYTES)
      // Kept rows only have blocks at or after their own, so clearing in ascending order never undoes earlier work.
      for (let index = 0; index < count; index++) {
        if (!blocks[index]) continue
        const row = rows[index]
        if (!row) {
          rows[index] = { blocks, data }
          rank++
          break
        }
        xorInto(blocks, row.blocks)
        xorInto(data, row.data)
      }
      if (rank === count) {
        for (let index = count - 1; index >= 0; index--) {
          const row = rows[index]
          for (let later = index + 1; later < count; later++) {
            if (row.blocks[later]) {
              xorInto(row.data, rows[later].data)
              row.blocks[later] = 0
            }
          }
        }
      }
      return true
    },
    get progress() { return { received: rank, total: count } },
    get done() { return count > 0 && rank === count },
    bytes() {
      const out = new Uint8Array(count * BLOCK_BYTES)
      rows.forEach((row, index) => out.set(row.data, index * BLOCK_BYTES))
      return out.subarray(0, length)
    },
  }
}

const blobBytes = async (blob) => new Uint8Array(await blob.arrayBuffer())

// WebP (about a third smaller than JPEG at the same look), or JPEG where it can't be encoded; see canvasToWebp.
const compressed = (canvas, transparent = false) => canvasToWebp(canvas, { quality: PHOTO_QUALITY, transparent })
const part = async (name, blob) => ({ name, type: blob.type, bytes: await blobBytes(blob) })

const shrunk = (blob) => decodeScaled(blob, PHOTO_DIMENSION)

// A sticker goes as one WebP, transparency included. Without WebP, its transparency doesn't survive JPEG, so it
// travels as a JPEG of its colours plus a greyscale JPEG of its alpha (a solid shape, so a few KB; far smaller than a
// PNG of its soft edge), and the receiver puts them back together.
async function stickerParts(blob) {
  const canvas = await shrunk(blob)
  const image = await compressed(canvas, true)
  if (image.type === 'image/webp') return [await part('front', image)]
  const context = canvas.getContext('2d')
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const mask = new ImageData(canvas.width, canvas.height)
  for (let i = 0; i < pixels.data.length; i += 4) {
    mask.data[i] = mask.data[i + 1] = mask.data[i + 2] = pixels.data[i + 3]
    mask.data[i + 3] = 255
  }
  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = canvas.width
  maskCanvas.height = canvas.height
  maskCanvas.getContext('2d').putImageData(mask, 0, 0)
  return [await part('front', await canvasToJpeg(canvas, PHOTO_QUALITY)), await part('frontMask', await canvasToJpeg(maskCanvas, PHOTO_QUALITY))]
}

export async function packCard(card) {
  const parts = card.kind === 'sticker'
    ? await stickerParts(card.front)
    : await Promise.all(['front', 'back'].filter((name) => card[name]).map(async (name) => part(name, await compressed(await shrunk(card[name])))))
  return joinParts({ card: Object.fromEntries(TEXT_FIELDS.filter((field) => card[field] != null).map((field) => [field, card[field]])) }, parts)
}

// Back to a card ready to store: photos as blobs, with no originals (re-editing starts from the photo itself).
export async function unpackCard(bytes) {
  const { card, parts } = splitParts(bytes)
  const blob = (part) => part && new Blob([part.bytes], { type: part.type })
  let front = blob(parts.front)
  if (parts.frontMask) {
    const [colours, mask] = await Promise.all([createImageBitmap(front), createImageBitmap(blob(parts.frontMask))])
    const canvas = scaledCanvas(colours)
    const maskCanvas = scaledCanvas(mask)
    const context = canvas.getContext('2d')
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    const alpha = maskCanvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    // JPEG ringing leaves faint values either side of the edge; snap those to fully clear or solid.
    const snap = (value) => (value < MASK_SNAP ? 0 : value > 255 - MASK_SNAP ? 255 : value)
    for (let i = 0; i < pixels.data.length; i += 4) pixels.data[i + 3] = snap(alpha[i])
    context.putImageData(pixels, 0, 0)
    front = await canvasToWebp(canvas, { transparent: true })
  }
  return { socials: [], ...card, front, back: blob(parts.back) ?? null }
}
