import { useEffect, useRef, useState } from 'preact/hooks'
import { renderSVG } from 'uqr'
import { t } from './i18n.js'
import { BackHeader } from './ui.jsx'
import { errorMessage } from './sync.jsx'
import { packCard, unpackCard, frameStream, frameCollector } from './beam.js'
import { newPairing, parsePairing, parseReceiveLink, parseSyncLink, receiveLink, startSync } from './sync.js'
import { saveCard } from './db.js'

// How long each QR code stays up (about 7 a second). Any frames will do, so showing them faster than the receiver
// reads costs nothing; the limit is the camera catching two codes blended mid-switch, which grows below ~100 ms.
const FRAME_MS = 140
// Frames shown per part a receiver needs, allowing for some it misses.
const EXPECTED_FRAMES_PER_PART = 1.3

const METHOD_KEY = 'beamMethod'

// Hands one card to another phone, two ways: offline, as a stream of QR codes; or over the network, as a QR link the
// other phone scans, then sends the card in full (originals too) over the same direct connection as sync.
export function BeamSend({ card, onClose }) {
  const [method, setMethod] = useState(() => (localStorage.getItem(METHOD_KEY) === 'network' ? 'network' : 'offline'))
  const choose = (next) => { localStorage.setItem(METHOD_KEY, next); setMethod(next) }
  return (
    <main class="beam">
      <BackHeader title={t('Beam by QR')} onBack={onClose} />
      <div class="segmented" role="radiogroup" aria-label={t('Send by')}>
        {[['offline', t('Offline')], ['network', t('Network')]].map(([value, label]) => (
          <button type="button" key={value} role="radio" aria-checked={method === value} onClick={() => choose(value)}>{label}</button>
        ))}
      </div>
      {method === 'offline' ? <OfflineSend card={card} /> : <NetworkSend card={card} />}
    </main>
  )
}

// An endless stream of QR codes carrying one card, for another phone's Receive screen to read.
function OfflineSend({ card }) {
  const [code, setCode] = useState(null)
  const [error, setError] = useState(null)
  // The sender can't see what the receiver catches, so this is the best case plus a margin for missed frames.
  const [estimate, setEstimate] = useState(null)

  useEffect(() => {
    let timer
    packCard(card).then((bytes) => {
      const stream = frameStream(bytes)
      setEstimate({ parts: stream.count, seconds: Math.max(1, Math.ceil((stream.count * EXPECTED_FRAMES_PER_PART * FRAME_MS) / 1000)) })
      const show = () => setCode(renderSVG(Array.from(stream.next()), { ecc: 'L', border: 4 }))
      show()
      timer = setInterval(show, FRAME_MS)
    }).catch((failure) => setError(failure.message))
    return () => clearInterval(timer)
  }, [])

  return (
    <>
      {/* uqr's own output: a static SVG built from our bytes, no markup from the card. */}
      {code && <div class="beam-qr" dangerouslySetInnerHTML={{ __html: code }} />}
      {!code && !error && <p class="muted">{t('Preparing…')}</p>}
      {error && <p class="cropper-error">{error}</p>}
      {code && <p class="beam-estimate">{t('{parts} parts · about {seconds} s to receive', estimate)}</p>}
      {code && <p class="muted">{t('On the other phone, open Cardbox → Settings → Scan QR code and point it at this screen. Turn your brightness up.')}</p>}
    </>
  )
}

// A one-time QR link; the phone that opens it receives this card, in full, over a direct connection. Only this card
// is offered, and nothing is taken back.
function NetworkSend({ card }) {
  // waiting | sending | sent | error
  const [stage, setStage] = useState('waiting')
  const [pairing, setPairing] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let session
    let stopped = false
    async function host(sessionPairing) {
      setPairing(sessionPairing)
      try {
        session = await startSync({
          role: 'host', pairing: sessionPairing, offer: [card.id], fetch: false,
          onStatus: (status) => status === 'syncing' && setStage('sending'), onProgress: () => {},
        })
        await session.done
        if (!stopped) setStage('sent')
      } catch (failure) {
        if (stopped) return
        // Someone else on the relay already holds this code: pick another.
        if (failure.type === 'unavailable-id') return host(newPairing())
        setError(errorMessage(failure))
        setStage('error')
      }
    }
    host(newPairing())
    return () => { stopped = true; session?.close() }
  }, [])

  return (
    <>
      {stage === 'waiting' && pairing && (
        <>
          {/* uqr's own output: a static SVG built from our link, no user content. */}
          <div class="beam-qr" dangerouslySetInnerHTML={{ __html: renderSVG(receiveLink(pairing), { border: 4 }) }} />
          <p class="muted">{t('Scan with the other phone’s camera, or Cardbox’s camera in QR mode. Both phones need internet.')}</p>
        </>
      )}
      {stage === 'sending' && <p class="beam-estimate">{t('Sending…')}</p>}
      {stage === 'sent' && <p class="beam-estimate">{t('Sent ✓')}</p>}
      {stage === 'error' && <p class="cropper-error">{error}</p>}
    </>
  )
}

// Reads scanned QR codes, one result at a time: a sync link goes to onSyncLink(the part after '#sync/'), a receive link
// to onReceiveLink(pairing), and a beamed card's codes are collected until the card is whole, then saved and passed to
// onCard(id). read(result) returns true once scanning can stop.
export function useQrReader({ onSyncLink, onReceiveLink, onCard }) {
  const collector = useRef(frameCollector())
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)
  // When the first part arrived, to estimate the time left from the rate since.
  const start = useRef(null)

  async function read(result) {
    const sync = result && parseSyncLink(result.text)
    if (sync) {
      onSyncLink(`${sync.code}.${sync.secret}`)
      return true
    }
    const link = result && parseReceiveLink(result.text)
    if (link) {
      onReceiveLink(link)
      return true
    }
    const bytes = result?.bytes
    if (!bytes || !collector.current.add(bytes)) return false
    const { received, total } = collector.current.progress
    start.current ??= { time: performance.now(), received }
    const gained = received - start.current.received
    // Only once a few parts are in, so one lucky early frame doesn't promise a wild estimate.
    const secondsLeft = gained >= 3 ? Math.ceil(((total - received) * (performance.now() - start.current.time)) / gained / 1000) : null
    setProgress({ percent: Math.floor((received / total) * 100), secondsLeft })
    if (!collector.current.done) return false
    try {
      const card = await unpackCard(collector.current.bytes())
      // Ids are random, so one already here is this same card beamed before: it's replaced by the newer copy.
      await saveCard({ ...card, createdAt: card.createdAt ?? new Date().toISOString() })
      onCard(card.id)
    } catch (failure) {
      setError(t('Could not read the card: {message}', { message: failure.message }))
    }
    return true
  }
  return { read, progress, error, setError }
}

export const progressText = (progress) => [t('Receiving…'), `${progress.percent}%`, progress.secondsLeft !== null && t('about {seconds} s left', { seconds: progress.secondsLeft })]
  .filter(Boolean).join(' · ')

// Opened from a receive link (the part after '#receive/', scanned with any camera): fetches the card over the network,
// then onDone(id) opens it.
export function BeamReceive({ code, onDone, onClose }) {
  const pairing = parsePairing(code)
  const [error, setError] = useState(pairing ? null : t('This link isn’t a Cardbox card.'))
  useEffect(() => {
    if (!pairing) return
    let session
    ;(async () => {
      try {
        session = await startSync({ role: 'guest', pairing, offer: [], onStatus: () => {}, onProgress: () => {} })
        const { ids } = await session.done
        if (ids[0]) onDone(ids[0])
        else setError(t('You already have this card.'))
      } catch (failure) {
        setError(errorMessage(failure))
      }
    })()
    return () => session?.close()
  }, [])

  return (
    <main class="beam">
      <BackHeader title={t('Receiving…')} onBack={onClose} />
      {error ? <p class="cropper-error">{error}</p> : <p class="beam-estimate">{t('Receiving…')}</p>}
    </main>
  )
}
