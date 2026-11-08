import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'
import { getCard, saveCard } from './db.js'
import { scaledCanvas } from './crop.js'

// Served with the app rather than from the library's default CDN, so scanning works offline like everything else.
prepareZXingModule({ overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) } })

// zxing (the engine behind Android's own reader) copes with what card art throws at it: several codes on one side,
// light-on-dark codes, logos in the middle, codes running to the card's edge.
const OPTIONS = { formats: ['QRCode'], tryHarder: true, tryInvert: true, tryRotate: true, tryDownscale: true, maxNumberOfSymbols: 8 }

// Returns the text of every QR code on the photo. Where the browser has its own detector (Chrome, Android) its finds
// are added too: on a test card with heavily styled codes it read one that zxing missed.
// Decoded by the browser first: zxing's own decoder only knows JPEG/PNG-era formats, not the WebP photos are stored as.
async function readQrCodes(blob) {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = scaledCanvas(bitmap)
    const context = canvas.getContext('2d')
    const pixels = () => context.getImageData(0, 0, canvas.width, canvas.height)
    const results = await readBarcodes(pixels(), { ...OPTIONS, returnErrors: true })
    const codes = results.filter((result) => result.isValid).map((result) => result.text)
    for (const failed of results.filter((result) => !result.isValid)) codes.push(...(await readPastLogo(context, failed.position, pixels)))
    if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
      codes.push(...(await new BarcodeDetector({ formats: ['qr_code'] }).detect(bitmap)).map((code) => code.rawValue))
    }
    return unique(codes)
  } finally {
    bitmap.close?.()
  }
}

// A code found but too damaged to read is usually one with a logo over its middle: a dark logo reads as solid modules,
// more errors than the code can correct. Painting the middle white gets about half of those modules right again.
const LOGO_FRACTIONS = [0.3, 0.4]
async function readPastLogo(context, position, pixels) {
  const corners = [position.topLeft, position.topRight, position.bottomRight, position.bottomLeft]
  const centre = { x: corners.reduce((sum, { x }) => sum + x, 0) / 4, y: corners.reduce((sum, { y }) => sum + y, 0) / 4 }
  const original = pixels()
  try {
    for (const fraction of LOGO_FRACTIONS) {
      context.putImageData(original, 0, 0)
      context.fillStyle = '#fff'
      context.beginPath()
      for (const { x, y } of corners) context.lineTo(centre.x + (x - centre.x) * fraction, centre.y + (y - centre.y) * fraction)
      context.fill()
      const found = (await readBarcodes(pixels(), OPTIONS)).filter((result) => result.isValid).map((result) => result.text)
      if (found.length) return found
    }
    return []
  } finally {
    context.putImageData(original, 0, 0)
  }
}

const unique = (values) => [...new Set(values.map((value) => value.trim()).filter(Boolean))]

// Codes on either side of the card that aren't already among socials.
export async function newSocialsFromQr(card, socials) {
  const codes = (await Promise.all([card.front, card.back].filter(Boolean).map(readQrCodes))).flat()
  const known = new Set(socials.map((social) => social.trim()))
  return { found: codes.length, added: unique(codes).filter((code) => !known.has(code)) }
}

// Adds the codes found on each card's photos to its Social list, saving as it goes. onCard(index) reports progress.
// Returns how many cards gained links.
export async function addQrSocials(cards, onCard) {
  let updated = 0
  for (const [index, card] of cards.entries()) {
    onCard?.(index)
    const { added } = await newSocialsFromQr(card, card.socials)
    if (!added.length) continue
    // Re-read: the card may have been edited while its photos were being scanned.
    const current = await getCard(card.id)
    if (!current) continue
    await saveCard({ ...current, socials: [...current.socials, ...added.filter((code) => !current.socials.includes(code))] })
    updated++
  }
  return updated
}

// One live camera frame on the Receive screen: the first QR code's { bytes, text } (a beamed frame, or a link to
// receive over the network), or null.
export async function readQrFrame(imageData) {
  const results = await readBarcodes(imageData, { formats: ['QRCode'], maxNumberOfSymbols: 1 })
  return results.find((result) => result.isValid) ?? null
}
