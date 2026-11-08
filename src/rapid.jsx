import { useEffect, useRef, useState } from 'preact/hooks'
import { normalizeOriginal, saveCard, sideFields, readLastEvent, writeLastEvent } from './db.js'
import { loadOpenCv, autoCrop, cutOutSticker, scaledCanvas } from './crop.js'
import { CornerEditor } from './cropper.jsx'
import { ArmedButton, Beta, CardImage, CollectionPicker } from './ui.jsx'
import { t } from './i18n.js'
import { useQrReader, progressText } from './beam.jsx'

const discardPrompt = (count) => (count === 1 ? t('Discard {count} shot?', { count }) : t('Discard {count} shots?', { count }))

const SIDE_LABELS = {
  front: { sure: t('front'), unsure: t('front · check') },
  back: { sure: t('back'), unsure: t('back · check') },
  sticker: { sure: t('sticker'), unsure: t('sticker · check') },
}

// Shoot a stack of cards with an in-app camera (photos never touch the photo library), then review and save them
// all. Shots alternate front, back, front, back; "No back" ends a card after its front. In Stickers mode each shot is
// one sticker, cut out along its outline.
// mode: 'cards' or 'stickers', what the camera starts on (the list's tab).
export function RapidCapture({ events, mode, onDone, onChanged, onCode, setLeaveGuard }) {
  // { front, back } of original photo blobs while shooting; cropped sides after review starts.
  const [cards, setCards] = useState([])
  const [reviewing, setReviewing] = useState(false)
  if (!reviewing) {
    return <Camera initialMode={mode} onCode={onCode} onFinish={(shot) => { setCards(shot); setReviewing(true) }} onCancel={onDone} setLeaveGuard={setLeaveGuard} />
  }
  return <Review shots={cards} events={events} onDone={onDone} onChanged={onChanged} setLeaveGuard={setLeaveGuard} />
}

const SHAPE_KEY = 'cameraCardShape'
const SCAN_DIMENSION = 800
const SCAN_INTERVAL = 200
const LIBRARY_ICON = <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>

// single: one photo for an existing card (a retake). The first shot or library pick goes straight to onFinish as a
// stored original, and the batch controls are hidden.
// onCode(hash): in QR mode, what a Cardbox QR code opens, as an app hash: a sync link, a receive link, or a card beamed
// in (collected and saved here, with its progress in the status line).
export function Camera({ initialMode, single = false, onFinish, onCancel, onCode, setLeaveGuard = () => {} }) {
  const videoRef = useRef()
  const streamRef = useRef()
  const [error, setError] = useState(null)
  // { cards: [{ front, back, kind? }], pendingFront } holding shot ids, in one state object so fast taps each build on the
  // latest. The photos themselves are encoded in the background and land in photosRef under their id.
  const [shots, setShots] = useState({ cards: [], pendingFront: null })
  const photosRef = useRef(new Map())
  // A small preview of each shot, made at the tap, for the last-shot thumbnail.
  const thumbnailsRef = useRef(new Map())
  const nextIdRef = useRef(1)
  const [processing, setProcessing] = useState(0)
  const [flash, setFlash] = useState(false)
  // The stream's shape (width / height); it flips when the phone turns.
  const [aspect, setAspect] = useState(null)
  const measure = ({ target }) => target.videoWidth && setAspect(target.videoWidth / target.videoHeight)
  const [mode, setMode] = useState(initialMode)
  const stickers = mode === 'stickers'
  const scanning = mode === 'qr'
  // The card's shape for the guide, chosen with a button rather than by turning the phone; remembered between visits.
  const [shape, setShape] = useState(() => (localStorage.getItem(SHAPE_KEY) === 'vertical' ? 'vertical' : 'horizontal'))
  const toggleShape = () => setShape((current) => {
    const next = current === 'vertical' ? 'horizontal' : 'vertical'
    localStorage.setItem(SHAPE_KEY, next)
    return next
  })

  useEffect(() => {
    let cancelled = false
    navigator.mediaDevices?.getUserMedia({
      audio: false,
      // Ask for the most the camera will stream; the browser picks the nearest it supports.
      video: { facingMode: 'environment', width: { ideal: 4096 }, height: { ideal: 4096 } },
    }).then((stream) => {
      if (cancelled) return stream.getTracks().forEach((track) => track.stop())
      streamRef.current = stream
      videoRef.current.srcObject = stream
    }, (failure) => setError(failure?.name === 'NotAllowedError'
      ? t('Camera access is off. Allow it for this site in your browser settings, or choose photos from your library.')
      : failure?.message || String(failure)))
    if (!navigator.mediaDevices) setError(t('This browser has no camera access here (it needs HTTPS).'))
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  function shoot() {
    const video = videoRef.current
    if (!video?.videoWidth) return
    // The frame is grabbed now, at the tap; encoding it can finish later.
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)
    setFlash(true)
    setTimeout(() => setFlash(false), 120)
    addShot(canvas, scaledCanvas(canvas, 160).toDataURL('image/jpeg', 0.7))
  }

  function addShot(source, thumbnail) {
    if (single) {
      if (processing) return
      setProcessing(1)
      normalizeOriginal(source).then(onFinish, (failure) => {
        setError(t('Could not save a shot: {message}', { message: failure.message }))
        setProcessing(0)
      })
      return
    }
    const id = nextIdRef.current++
    thumbnailsRef.current.set(id, thumbnail)
    setShots(({ cards, pendingFront }) => (stickers
      ? { cards: [...cards, { front: id, back: null, kind: 'sticker' }], pendingFront }
      : pendingFront
        ? { cards: [...cards, { front: pendingFront, back: id }], pendingFront: null }
        : { cards, pendingFront: id }))
    setProcessing((count) => count + 1)
    normalizeOriginal(source)
      .then((photo) => photosRef.current.set(id, photo), (failure) => setError(t('Could not save a shot: {message}', { message: failure.message })))
      .finally(() => setProcessing((count) => count - 1))
  }

  // Done waits for encoding to finish (the button is disabled meanwhile), so every id has its photo here.
  const photosFor = (list) => list.map(({ front, back, kind }) => ({
    front: photosRef.current.get(front), back: back ? photosRef.current.get(back) : null, kind,
  }))

  const noBack = () => setShots(({ cards, pendingFront }) => (pendingFront ? { cards: [...cards, { front: pendingFront, back: null }], pendingFront: null } : { cards, pendingFront }))

  const undo = () => setShots(({ cards, pendingFront }) => {
    if (pendingFront) return { cards, pendingFront: null }
    const last = cards.at(-1)
    if (!last) return { cards, pendingFront }
    // Undoing a back reopens its card for a new back shot.
    return { cards: cards.slice(0, -1), pendingFront: last.back ? last.front : null }
  })

  const { cards, pendingFront } = shots
  const finished = pendingFront ? [...cards, { front: pendingFront, back: null }] : cards
  useEffect(() => {
    setLeaveGuard(finished.length ? () => confirm(discardPrompt(finished.length)) : null)
  }, [finished.length])
  const cardNumber = cards.length + 1

  const qr = useQrReader({
    onSyncLink: (code) => onCode(`#sync/${code}`),
    onReceiveLink: ({ code, secret }) => onCode(`#receive/${code}.${secret}`),
    onCard: (id) => onCode(`#card/${encodeURIComponent(id)}`),
  })
  useEffect(() => {
    if (!scanning) return
    let stopped = false
    let timer
    const canvas = document.createElement('canvas')
    ;(async () => {
      const { readQrFrame } = await import('./qr.js')
      const scan = async () => {
        const video = videoRef.current
        if (stopped) return
        if (video?.videoWidth) {
          const scale = Math.min(1, SCAN_DIMENSION / Math.max(video.videoWidth, video.videoHeight))
          canvas.width = Math.round(video.videoWidth * scale)
          canvas.height = Math.round(video.videoHeight * scale)
          const context = canvas.getContext('2d', { willReadFrequently: true })
          context.drawImage(video, 0, 0, canvas.width, canvas.height)
          const result = await readQrFrame(context.getImageData(0, 0, canvas.width, canvas.height))
          if (stopped || (await qr.read(result))) return
        }
        timer = setTimeout(scan, SCAN_INTERVAL)
      }
      scan()
    })()
    return () => { stopped = true; clearTimeout(timer) }
  }, [scanning])
  // Photos from the library, taken in order like shots (front, back, next card…); one only for a retake.
  const libraryPicker = (className, content) => (
    <label class={className} aria-label={t('Choose from library')}>
      {content}
      <input
        type="file" accept="image/*" multiple={!single} hidden
        onChange={(e) => { const files = [...e.target.files]; e.target.value = ''; files.forEach((file) => addShot(file, URL.createObjectURL(file))) }}
      />
    </label>
  )
  // The shot undo discards: a waiting front, else the last card's back, else its front.
  const lastShot = pendingFront ?? cards.at(-1)?.back ?? cards.at(-1)?.front

  return (
    <div class="cropper rapid">
      <div class="cropper-stage">
        {error
          ? (
            <div class="rapid-unavailable">
              <p class="cropper-error">{t('Camera unavailable: {message}', { message: error })}</p>
              {libraryPicker('button glass', t('Choose from library'))}
            </div>
          )
          : (
            <div class="rapid-frame" style={aspect && { '--aspect': aspect }}>
              <video ref={videoRef} class="rapid-video" autoplay playsinline muted onLoadedMetadata={measure} onResize={measure} />
              {aspect && <div class={`rapid-guide${scanning ? ' qr' : stickers ? ' square' : shape === 'vertical' ? ' portrait' : ''}`} />}
            </div>
          )}
        {flash && <div class="rapid-flash" />}
      </div>
      {/* Camera-app layout: a bar of close, card shape and Done above the view; shutter and modes below it. */}
      <div class="rapid-top">
        <button type="button" class="icon-button" aria-label={t('Cancel')} onClick={onCancel}>✕</button>
        {!stickers && !scanning && (
          <button type="button" class="rapid-shape" aria-label={shape === 'vertical' ? t('Vertical card') : t('Horizontal card')} onClick={toggleShape}>
            {/* The card's current shape, with a turn arrow to say tapping rotates it. */}
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              {shape === 'vertical' ? <rect x="3" y="8" width="10" height="14" rx="2" /> : <rect x="2" y="10" width="15" height="10" rx="2" />}
              <path d="M13 3a8 8 0 0 1 8 8" /><path d="m18 9 3 2.5 2.5-3" />
            </svg>
          </button>
        )}
        {!single && !scanning && <button type="button" class="rapid-done glass" disabled={!finished.length || processing > 0} onClick={() => onFinish(photosFor(finished))}>
          {processing > 0 ? t('Saving shots…') : t('Done ({count})', { count: finished.length })}
        </button>}
      </div>
      <div class="rapid-controls">
        {!single && (
          <p class="rapid-status">
            {scanning ? qr.error ?? (qr.progress ? progressText(qr.progress) : t('Point the camera at a Cardbox QR code.'))
              : stickers
              ? t('Capture sticker {number}', { number: cardNumber })
              : pendingFront ? t('Capture back of card {number}, or skip', { number: cardNumber }) : t('Capture front of card {number}', { number: cardNumber })}
            {finished.length > 0 && <span class="muted"> · {t('{count} so far', { count: finished.length })}</span>}
          </p>
        )}
        <div class="rapid-shutter-row" style={scanning ? { visibility: 'hidden' } : undefined}>
          {lastShot && !single ? (
            // Where the Camera app shows the latest photo: the last shot, tap to discard it.
            <button type="button" class="rapid-last" aria-label={t('Discard last shot')} onClick={undo}>
              <img src={thumbnailsRef.current.get(lastShot)} alt="" />
              <span class="rapid-last-discard" aria-hidden="true">✕</span>
            </button>
          ) : libraryPicker('button icon-button', LIBRARY_ICON)}
          <button type="button" class="rapid-shutter" disabled={!!error || (single && processing > 0)} onClick={shoot} aria-label={stickers ? t('Take sticker') : pendingFront ? t('Take back') : t('Take front')} />
          <button type="button" class="rapid-no-back glass" disabled={!pendingFront} hidden={stickers || single} onClick={noBack}>{t('Skip')}</button>
        </div>
        {/* Like the Camera app's Photo / Video: locked while a card is waiting for its back. */}
        {!single && <div class="rapid-modes" role="radiogroup" aria-label={t('Capture')}>
          {[['cards', t('Cards')], ['stickers', t('Stickers')]].map(([value, label]) => (
            <button type="button" key={value} role="radio" aria-checked={mode === value} disabled={!!pendingFront && mode !== value} onClick={() => setMode(value)}>{label}{value === 'stickers' && <Beta />}</button>
          ))}
          {/* Finding a code leaves the camera, losing any shots taken. */}
          {onCode && <button type="button" role="radio" aria-checked={scanning} disabled={finished.length > 0} onClick={() => setMode('qr')}>QR</button>}
        </div>}
      </div>
    </div>
  )
}

function Review({ shots, events, onDone, onChanged, setLeaveGuard }) {
  // null until every shot is cropped; cards can then be removed, so its length no longer tracks shots.
  const [cards, setCards] = useState(null)
  const [progress, setProgress] = useState(0)
  const [failure, setFailure] = useState(null)
  const [event, setEvent] = useState(readLastEvent)
  // { index, name: 'front' | 'back' } while the crop editor is open for one side.
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const cv = await loadOpenCv()
      const cropped = []
      for (const shot of shots) {
        if (cancelled) return
        cropped.push(shot.kind === 'sticker'
          ? { kind: 'sticker', front: await cutOutSticker(cv, shot.front), back: null }
          : { front: await autoCrop(cv, shot.front), back: shot.back && (await autoCrop(cv, shot.back)) })
        setProgress(cropped.length)
      }
      if (!cancelled) setCards(cropped)
    })().catch((error) => !cancelled && setFailure(error.message))
    return () => { cancelled = true }
  }, [])

  // Guarded from the start, while photos are still being cropped too.
  const count = cards ? cards.length : shots.length
  useEffect(() => {
    setLeaveGuard(count ? () => confirm(discardPrompt(count)) : null)
  }, [count])

  const update = (index, change) => setCards(cards.map((card, i) => (i === index ? { ...card, ...change } : card)))

  async function saveAll() {
    setSaving(true)
    const trimmed = event.trim()
    const now = Date.now()
    const saved = cards.map((card, index) => ({
      id: crypto.randomUUID(),
      // Newest-first ordering would reverse the stack, so the first card shot gets the latest time.
      createdAt: new Date(now - index).toISOString(),
      name: '', socials: [], collections: trimmed ? [trimmed] : [], orders: {}, note: '',
      ...(card.kind && { kind: card.kind }),
      ...sideFields('front', card.front), ...sideFields('back', card.back),
    }))
    for (const card of saved) await saveCard(card)
    writeLastEvent(trimmed)
    onDone()
    // QR links are filled in after the list is back, so a big stack doesn't hold up saving.
    import('./qr.js')
      .then(({ addQrSocials }) => addQrSocials(saved))
      .then((updated) => updated && onChanged())
      .catch((error) => console.error(error))
  }

  if (failure) {
    return (
      <main>
        <h1>{t('Review')}</h1>
        <p class="cropper-error">{t('Could not crop the photos: {message}', { message: failure })}</p>
        <button type="button" onClick={onDone}>{t('Back')}</button>
      </main>
    )
  }
  if (!cards) {
    return (
      <main>
        <h1>{t('Review')}</h1>
        <p class="muted">{t('Cropping {current} of {total}…', { current: Math.min(progress + 1, shots.length), total: shots.length })}</p>
        <progress class="beam-progress" max={shots.length} value={progress} />
        {/* Edge detection loads on first use, which can take a few seconds. */}
        {progress === 0 && <p class="muted hint">{t('The first time takes a few seconds while edge detection loads.')}</p>}
        <div class="settings-list">
          <ArmedButton label={t('Discard')} armedLabel={t('Tap again to discard all')} onConfirm={onDone} />
        </div>
      </main>
    )
  }

  const editingSide = editing && cards[editing.index][editing.name]
  const unsure = cards.filter((card) => !card.front.detected || (card.back && !card.back.detected)).length

  return (
    <main>
      {editingSide && (
        <CornerEditor
          original={editingSide.original}
          edit={editingSide.edit}
          sticker={cards[editing.index].kind === 'sticker'}
          onCancel={() => setEditing(null)}
          onDone={({ image, edit }) => {
            update(editing.index, { [editing.name]: { ...editingSide, image, edit, detected: true } })
            setEditing(null)
          }}
        />
      )}
      <header class="list-header">
        <h1>{t('Review')}</h1>
        <button type="button" class="nav-action" disabled={!cards.length || saving} onClick={saveAll}>
          {saving ? t('Saving…') : t('Save {count}', { count: cards.length })}
        </button>
      </header>
      {unsure > 0 && <p class="muted">{t('{count} marked “check”: no edge was found, so the whole photo was kept. Tap a photo to crop it.', { count: unsure })}</p>}
      <div class="settings-list">
        <label class="field-row stacked">{t('Collection for all')}<CollectionPicker value={event} events={events} onChange={setEvent} /></label>
      </div>
      <div class="settings-list">
      {cards.map((card, index) => (
        <div class="rapid-card" key={index}>
          <span class="rapid-number">{index + 1}</span>
          {/* A sticker's photo opens the rectangle editor too, as the fallback for a bad cut-out. */}
          {(card.kind === 'sticker' ? ['front'] : ['front', 'back']).map((name) => (card[name]
            ? (
              <button type="button" class="rapid-side" key={name} onClick={() => setEditing({ index, name })}>
                <CardImage blob={card[name].image} className="rapid-thumb" />
                <small>{SIDE_LABELS[card.kind === 'sticker' ? 'sticker' : name][card[name].detected ? 'sure' : 'unsure']}</small>
              </button>
            )
            : <span class="rapid-side rapid-missing" key={name}><small>{t('no back')}</small></span>))}
          <div class="rapid-card-actions">
            {card.back && <button type="button" class="icon-button" aria-label={t('Swap front and back')} onClick={() => update(index, { front: card.back, back: card.front })}>⇄</button>}
            <button type="button" class="icon-button" aria-label={t('Remove')} onClick={() => setCards(cards.filter((_, i) => i !== index))}>✕</button>
          </div>
        </div>
      ))}
      </div>
      <div class="settings-list">
        <ArmedButton label={t('Discard')} armedLabel={t('Tap again to discard all')} onConfirm={onDone} />
      </div>
    </main>
  )
}
