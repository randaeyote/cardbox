import JSZip from 'jszip'
import { IMAGE_FIELDS, listCards, storeCard, setLastBackup } from './db.js'
import { t } from './i18n.js'

// Photos are JPEG; sticker cut-outs are PNG, for their transparent background.
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
export const extensionOf = (blob) => EXTENSIONS[blob.type] ?? 'jpg'
const imagePath = (id, field, blob) => `images/${id}-${field.replace('Original', '-original')}.${extensionOf(blob)}`

function cardsToManifest(cards) {
  return cards.map((card) => ({
    ...card,
    ...Object.fromEntries(IMAGE_FIELDS.map((field) => [field, card[field] ? imagePath(card.id, field, card[field]) : null])),
  }))
}

export async function exportBackup() {
  const cards = await listCards()
  const zip = new JSZip()
  zip.file('cards.json', JSON.stringify(cardsToManifest(cards), null, 2))
  for (const card of cards) {
    for (const field of IMAGE_FIELDS) if (card[field]) zip.file(imagePath(card.id, field, card[field]), card[field])
  }
  const blob = await zip.generateAsync({ type: 'blob' })
  const filename = `cardbox-backup-${new Date().toISOString().slice(0, 10)}.zip`
  const file = new File([blob], filename, { type: 'application/zip' })
  await shareOrDownload(file)
  await setLastBackup(new Date().toISOString())
}

// Returns the ids stored. onCard(done, total) reports progress, since saving a big backup's photos takes a while on a phone.
export async function importBackup(file, onCard = () => {}) {
  const zip = await JSZip.loadAsync(file)
  const manifestEntry = zip.file('cards.json')
  if (!manifestEntry) throw new Error(t('Not a Cardbox backup (cards.json missing)'))
  const manifest = JSON.parse(await manifestEntry.async('string'))
  const readImage = async (path) => {
    const entry = path && zip.file(path)
    return entry ? new Blob([await entry.async('arraybuffer')], { type: Object.keys(EXTENSIONS).find((type) => path.endsWith(`.${EXTENSIONS[type]}`)) ?? 'image/jpeg' }) : null
  }
  const ids = []
  for (const [index, entry] of manifest.entries()) {
    onCard(index, manifest.length)
    const images = {}
    for (const field of IMAGE_FIELDS) images[field] = await readImage(entry[field])
    if (!entry.id || !images.front) continue
    await storeCard({ ...entry, ...images })
    ids.push(entry.id)
  }
  return ids
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

export async function shareOrDownload(file) {
  if (!navigator.canShare?.({ files: [file] })) return downloadBlob(file, file.name)
  try {
    await navigator.share({ files: [file] })
  } catch (error) {
    // Safari rejects share() once the tap's user activation expires, e.g. after zipping many images.
    if (error.name !== 'NotAllowedError') throw error
    downloadBlob(file, file.name)
  }
}

export const shareFile = (file) =>
  shareOrDownload(file).catch((error) => error.name !== 'AbortError' && alert(error.message))
