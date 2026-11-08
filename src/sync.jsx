import { useEffect, useRef, useState } from 'preact/hooks'
import { renderSVG } from 'uqr'
import { t } from './i18n.js'
import { BackHeader } from './ui.jsx'
import { newPairing, parsePairing, startSync, syncLink } from './sync.js'
import { setLastBackup } from './db.js'

const RELAY_ERRORS = ['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected']

export function errorMessage(error) {
  if (error.type === 'version-mismatch') return t('The two devices are on different versions of Cardbox. Reload the app on both (it may take two reloads), then try again.')
  if (error.type === 'pairing-failed') return t('Could not verify the other device. Scan the code again; both devices need the latest Cardbox (reload the app, maybe twice).')
  if (error.type === 'timeout') return t('Could not connect to the other device. Check both are online and on the latest Cardbox (reload the app, maybe twice), then try again.')
  if (error.type === 'peer-unavailable') return t('Code not found. Check the other device is still showing it.')
  if (RELAY_ERRORS.includes(error.type)) return t('Could not reach the pairing service. Check the internet connection.')
  return t('Sync stopped: {message}', { message: error.message })
}

function summary({ received, sent }) {
  if (!received && !sent) return t('Already in sync.')
  return t('Synced: {received} received, {sent} sent.', { received, sent })
}

// Pairs two devices with a one-time QR link and syncs their cards directly. Opened plainly it shows the link; opened
// from a scanned one (initialCode: the part after '#sync/') it joins. The app's one scanner reads the link, so this
// screen has none. There's no typed code: it couldn't carry the pairing secret, and without that the host can't tell
// the device it's showing the code to from anyone else who connects.
export function SyncScreen({ initialCode, onDone }) {
  const initial = initialCode ? parsePairing(initialCode) : null
  // waiting | syncing | done | error
  const [stage, setStage] = useState(initial ? 'syncing' : 'waiting')
  const [pairing, setPairing] = useState(null)
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState('')
  const sessionRef = useRef(null)
  // Bumped whenever a session is started or abandoned, so a late result from an old one is ignored.
  const attemptRef = useRef(0)
  const stop = () => {
    attemptRef.current++
    sessionRef.current?.close()
  }

  useEffect(() => {
    if (initial) join(initial)
    else host()
    return stop
  }, [])

  async function begin(role, sessionPairing) {
    stop()
    const attempt = attemptRef.current
    setPairing(sessionPairing)
    setProgress(null)
    setStage(role === 'host' ? 'waiting' : 'syncing')
    try {
      const session = await startSync({ role, pairing: sessionPairing, onStatus: (status) => status === 'syncing' && setStage('syncing'), onProgress: setProgress })
      sessionRef.current = session
      const counts = await session.done
      // After a sync the other device holds a copy of every card here, so it counts as a backup.
      await setLastBackup(new Date().toISOString())
      if (attempt !== attemptRef.current) return
      setResult(summary(counts))
      setStage('done')
    } catch (error) {
      if (attempt !== attemptRef.current) return
      // Someone else on the relay already holds this code: pick another.
      if (role === 'host' && error.type === 'unavailable-id') return begin('host', newPairing())
      setResult(errorMessage(error))
      setStage('error')
    }
  }
  const host = () => begin('host', newPairing())
  const join = (sessionPairing) => begin('guest', sessionPairing)

  return (
    <div class="sync">
      <BackHeader title={t('Sync')} onBack={onDone} />
      {stage === 'waiting' && pairing && (
        <>
          {/* uqr's own output: a static SVG built from our link, no user content. */}
          <div class="sync-qr" dangerouslySetInnerHTML={{ __html: renderSVG(syncLink(pairing), { border: 2 }) }} />
          <p class="muted">{t('On the other device, open Cardbox → Settings → Scan QR code, or use its camera app.')}</p>
          <p class="settings-note">{t('Each gets the cards it is missing. Nothing is deleted.')}</p>
          <p class="settings-note">{t('Cards go directly between the devices, not through a server.')}</p>
        </>
      )}
      {stage === 'syncing' && (
        <p>{progress?.total ? t('Syncing… {received} of {total} cards received', progress) : t('Connecting…')}</p>
      )}
      {(stage === 'done' || stage === 'error') && (
        <>
          <p class={stage === 'error' ? 'cropper-error' : ''}>{result}</p>
          {stage === 'done'
            ? <button type="button" class="primary" onClick={onDone}>{t('Done')}</button>
            : !initial && <button type="button" onClick={host}>{t('Try again')}</button>}
        </>
      )}
    </div>
  )
}

