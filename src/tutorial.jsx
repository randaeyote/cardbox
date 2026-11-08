import { useEffect, useRef, useState } from 'preact/hooks'
import { t, language } from './i18n.js'
import { LanguageSwitch } from './ui.jsx'

// Screenshots (and, for the first slide, a short clip) of the app with made-up cards, one per slide and language. Imported so their names carry a hash and a
// redone set replaces any cached one.
const shots = import.meta.glob('./tutorial/*.{webp,mp4}', { eager: true, query: '?url', import: 'default' })

const SEEN_KEY = 'tutorialSeen'
export const tutorialSeen = () => !!localStorage.getItem(SEEN_KEY)

const slides = () => [
  ['welcome.mp4', t('Welcome to Cardbox'), t('Keep the cards and stickers you collect at events. Everything stays on this phone.')],
  ['camera.mp4', t('Shoot a stack'), t('Tap the camera button and shoot a card’s front, then its back, then the next card. Cardbox crops each one. On the Stickers tab, each shot is one sticker, cut out along its edge.')],
  ['collections.webp', t('Collections'), t('Group cards into collections however you like. A card can be in several. Tap Select to sort many at once.')],
  ['browse.mp4', t('Browse'), t('Slide a finger along a row to fan the cards open, and tap one to see it. Hold a card still to lift it, then drag it to a new place.')],
  ['collage.mp4', t('Collage'), t('Tap Collage, pick a collection, and get one picture of all its cards and stickers. Shuffle until you like it, then share it.')],
  ['share.webp', t('Share'), t('Open a card, tap the share button and choose Network. Your friend scans the code with their phone’s camera, and the card arrives in full. Settings → Sync keeps two of your own devices the same.')],
  ['backup.webp', t('Back up'), t('Photos live only on this phone. Export a backup in Settings now and then.')],
]

// A few swipeable screens shown on first open, and again from Settings.
export function Tutorial({ onDone }) {
  const dialogRef = useRef()
  const trackRef = useRef()
  const [index, setIndex] = useState(0)
  const list = slides()
  const last = index === list.length - 1
  // Focus the dialog itself, not Skip (its first button), so Skip doesn't open with a focus ring.
  useEffect(() => { dialogRef.current.showModal(); dialogRef.current.focus() }, [])
  // A clip starts from the top when its slide comes into view, not partway through a loop it played off screen. Its
  // page dot fills as it plays, so it's clear something is moving.
  const dotsRef = useRef()
  useEffect(() => {
    const video = trackRef.current.children[index]?.querySelector('video')
    if (!video) return
    video.currentTime = 0
    video.play().catch(() => {})
    const dot = dotsRef.current.children[index]
    let frame
    const update = () => {
      dot.style.setProperty('--progress', `${(video.currentTime / video.duration || 0) * 100}%`)
      frame = requestAnimationFrame(update)
    }
    update()
    return () => { cancelAnimationFrame(frame); dot.style.removeProperty('--progress') }
  }, [index])
  const finish = () => { localStorage.setItem(SEEN_KEY, '1'); onDone() }
  const go = (next) => trackRef.current.scrollTo({ left: next * trackRef.current.clientWidth, behavior: 'smooth' })

  return (
    <dialog ref={dialogRef} class="tutorial" tabIndex={-1} onCancel={(e) => { e.preventDefault(); finish() }}>
      <div class="tutorial-bar">
        {/* The first page has no Back; a first-time reader may need the other language there instead. */}
        {index
          ? <button type="button" class="tutorial-back" onClick={() => go(index - 1)}>‹ {t('Back')}</button>
          : <div><LanguageSwitch class="tutorial-language" /></div>}
        <button type="button" class="tutorial-skip" onClick={finish}>{t('Skip')}</button>
      </div>
      <div class="tutorial-track" ref={trackRef} onScroll={(e) => setIndex(Math.round(e.target.scrollLeft / e.target.clientWidth))}>
        {list.map(([shot, title, text]) => (
          <section key={title} class="tutorial-slide">
            {shot.endsWith('.mp4')
              ? <video class="tutorial-shot" src={shots[`./tutorial/${language}-${shot}`]} autoplay muted loop playsinline aria-hidden="true" />
              : <img class="tutorial-shot" src={shots[`./tutorial/${language}-${shot}`]} alt="" />}
            <h2>{title}</h2>
            <p>{text}</p>
          </section>
        ))}
      </div>
      <div class="tutorial-dots" ref={dotsRef} aria-hidden="true">
        {list.map(([shot], dot) => <span key={dot} class={dot !== index ? '' : shot.endsWith('.mp4') ? 'current clip' : 'current'} />)}
      </div>
      <button type="button" class="tutorial-next" onClick={() => (last ? finish() : go(index + 1))}>{last ? t('Get started') : t('Continue')}</button>
    </dialog>
  )
}
