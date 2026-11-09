import { useEffect, useRef, useState } from 'preact/hooks'
import { t } from './i18n.js'
import { useUnsavedWork } from './update.js'
import { BackHeader, QrLink, CardImage, cardCornerStyle, toggled } from './ui.jsx'
import { forgetShown, rememberShown, shownPairing, newPairing, parsePairing, startSync, syncLink, RELAY_ERRORS } from './sync.js'
import { setLastBackup, getCards, deleteCard, saveCard } from './db.js'

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
  // waiting | syncing | review (deletes from the other device to confirm) | done | error
  const [stage, setStage] = useState(initial ? 'syncing' : 'waiting')
  const [pairing, setPairing] = useState(null)
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState('')
  // The cards the other device deleted, and the ids of those unticked to keep.
  const [deletes, setDeletes] = useState([])
  const [kept, setKept] = useState(() => new Set())
  const sessionRef = useRef(null)
  // Bumped whenever a session is started or abandoned, so a late result from an old one is ignored.
  const attemptRef = useRef(0)
  const stop = () => {
    attemptRef.current++
    sessionRef.current?.close()
  }

  useUnsavedWork()
  useEffect(() => {
    const shown = shownPairing()
    if (initial) join(initial)
    else if (shown?.kind === 'sync') begin('host', shown.pairing, true)
    else host()
    return () => { stop(); forgetShown() }
  }, [])

  async function begin(role, sessionPairing, resume = false) {
    stop()
    if (role === 'host') rememberShown({ kind: 'sync', pairing: sessionPairing })
    const attempt = attemptRef.current
    setPairing(sessionPairing)
    setProgress(null)
    setStage(role === 'host' ? 'waiting' : 'syncing')
    try {
      const session = await startSync({ role, pairing: sessionPairing, resume, onStatus: (status) => status === 'syncing' && setStage('syncing'), onProgress: setProgress })
      sessionRef.current = session
      const counts = await session.done
      forgetShown()
      // After a sync the other device holds a copy of every card here, so it counts as a backup.
      await setLastBackup(new Date().toISOString())
      if (attempt !== attemptRef.current) return
      setResult(summary(counts))
      const cards = await getCards(counts.deleted)
      if (attempt !== attemptRef.current) return
      setDeletes(cards)
      setStage(cards.length ? 'review' : 'done')
    } catch (error) {
      if (attempt !== attemptRef.current) return
      // Someone else on the relay already holds this code: pick another.
      if (role === 'host' && error.type === 'unavailable-id') return begin('host', newPairing())
      setResult(errorMessage(error))
      setStage('error')
    }
  }
  // Deletes the ticked cards; saves the kept ones as just edited, so the next sync takes them back to the other device.
  async function confirmDeletes() {
    for (const card of deletes) await (kept.has(card.id) ? saveCard(card) : deleteCard(card.id))
    const count = deletes.length - kept.size
    setResult(`${result} ${t('{count} deleted.', { count })}`)
    setStage('done')
  }
  const toggle = (id) => setKept((current) => toggled(current, id))
  const host = () => begin('host', newPairing())
  const join = (sessionPairing) => begin('guest', sessionPairing)

  return (
    <div class="sync">
      <BackHeader title={t('Sync')} onBack={onDone} />
      {stage === 'waiting' && pairing && (
        <>
          <QrLink class="sync-qr" link={syncLink(pairing)} border={2} />
          <p class="muted">{t('On the other device, scan this with Cardbox’s camera in QR mode, or with its camera app.')}</p>
          <p class="settings-note">{t('Each gets the cards it is missing. Cards deleted on one are listed on the other for you to confirm.')}</p>
          <p class="settings-note">{t('Cards go directly between the devices, not through a server.')}</p>
        </>
      )}
      {stage === 'syncing' && (
        <p>{progress?.total ? t('Syncing… {received} of {total} cards received', progress) : t('Connecting…')}</p>
      )}
      {stage === 'review' && (
        <>
          <p>{t('{count} cards were deleted on the other device. Delete them here too?', { count: deletes.length })}</p>
          <p class="settings-note">{t('Untick any to keep. A kept card goes back to the other device on the next sync.')}</p>
          <div class="sync-deletes">
            {deletes.map((card) => (
              <label key={card.id} class={kept.has(card.id) ? 'kept' : ''}>
                <input type="checkbox" checked={!kept.has(card.id)} onChange={() => toggle(card.id)} />
                <CardImage blob={card.front} className={card.kind === 'sticker' ? 'sticker' : ''} style={cardCornerStyle(card)} />
                {card.name && <span>{card.name}</span>}
              </label>
            ))}
          </div>
          <button type="button" class={kept.size < deletes.length ? 'danger' : 'primary'} onClick={confirmDeletes}>
            {kept.size < deletes.length ? t('Delete {count}', { count: deletes.length - kept.size }) : t('Keep all')}
          </button>
        </>
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

