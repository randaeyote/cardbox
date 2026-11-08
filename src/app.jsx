import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { t, language, setLanguage, LANGUAGES } from './i18n.js'
import {
  canStorePhotos, getCard,
  listCards, saveCard, saveCards, deleteCard, deleteAllCards, getLastBackup, compareInGroup, sideOf, sideFields,
  convertPhotosToWebp, measureOldCorners, IMAGE_FIELDS, thumbnailFor,
} from './db.js'
import { exportBackup, importBackup, shareFile } from './backup.js'
import { LanguageSwitch, Logo } from './ui.jsx'
import { setUnsavedWork } from './update.js'
import { PackOpening } from './pack.jsx'
import { CornerEditor } from './cropper.jsx'
import { loadOpenCv, cutOutSticker } from './crop.js'
import { ArmedButton, BackHeader, Beta, CardImage, CollectionChips, NewCollectionInput, cornerStyle, usePinchZoom } from './ui.jsx'
import { Card3D } from './card3d.jsx'
import { RapidCapture, Camera } from './rapid.jsx'
import { BeamSend, BeamReceive } from './beam.jsx'
import { Tutorial, tutorialSeen } from './tutorial.jsx'
import { describeSocial } from './social.js'
import { loadThumbnails, collageItems, drawCards, warpLayer, composeCollage, DEFAULT_FILL, DEFAULT_STICKER_SIZE, DEFAULT_TILT, DEFAULT_OVERLAP, MAX_TILT_LIMIT, MAX_OVERLAP_LIMIT, DEFAULT_TIDY_GAP, MAX_TIDY_GAP } from './collage.js'
import { SyncScreen } from './sync.jsx'
import { useReorder } from './reorder.js'

const searchText = (card) => [card.name, ...card.collections, card.note, ...(card.socials || [])].join(' ').toLowerCase()
const BACKUP_STALE_DAYS = 7
// Below this many cards a missing backup isn't worth a warning dot: losing a few is cheap, and a brand-new user's
// first save shouldn't look like something went wrong.
const BACKUP_MIN_CARDS = 10

// A card in the rows view: front and back side by side for portrait cards, stacked for landscape ones (going by
// the front), so every pair takes a similar, squarish space. Its links are listed underneath.
// dragHandlers: the reorder gesture's props, when the row can be dragged to reorder.
// sides: 'both', 'front' or 'back'; a card with no back shows its front either way.
function CardRow({ card, sides, pressed, dragging, dragHandlers, onActivate }) {
  const [landscape, setLandscape] = useState(false)
  return (
    <div class={['card-row', pressed && 'selected', landscape && 'landscape', dragging && 'dragging', card.kind === 'sticker' && 'sticker'].filter(Boolean).join(' ')} onClick={onActivate} {...dragHandlers}>
      {pressed !== undefined && <span class="select-mark" aria-hidden="true">{pressed && '✓'}</span>}
      <button type="button" class="card-row-thumb" aria-label={card.name ? t('Open {name}', { name: card.name }) : t('Open card')} aria-pressed={pressed}>
        {(sides !== 'back' || !card.back) && <Thumbnail card={card} side="front" onLoad={(e) => setLandscape(e.target.naturalWidth > e.target.naturalHeight)} />}
        {sides !== 'front' && card.back && <Thumbnail card={card} side="back" />}
      </button>
      <div class="card-row-info">
        {card.socials.map((social) => {
          const { text, href } = describeSocial(social)
          return href
            ? <a key={social} href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{text}</a>
            : <span key={social}>{text}</span>
        })}
      </div>
    </div>
  )
}

// A collection is laid out as overlapping rows ("hands") of this many cards: 20 across a wide screen (the same width as
// the grid layout's breakpoint), 10 on a phone.
const WIDE_SCREEN = '(min-width: 720px)'
function useCardsPerFan() {
  const [wide, setWide] = useState(() => matchMedia(WIDE_SCREEN).matches)
  useEffect(() => {
    const query = matchMedia(WIDE_SCREEN)
    const update = () => setWide(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return wide ? 20 : 10
}

// A hand of cards, each showing a strip, overlapping like playing cards. Pointing at one, or sliding a finger along
// the hand (it only lets the page scroll up and down, so a sideways slide reaches it), opens the card there: the others
// close up to show it whole. A lifted finger leaves it open; a pointer leaving the hand closes it. side: 'front' or
// 'back' (front when a card has no back).
// dragId: the card being dragged to reorder, if any (in any hand); dragHandlers(id): a card's useReorder rowProps.
function CardFan({ cards, first, side, selected, dragId, dragHandlers, onActivate }) {
  const [focused, setFocused] = useState(null)
  const fanRef = useRef()
  // Each card's width when open, as a share of the hand's height (a turned card turns back to lie full height wide),
  // reported once its photo loads; the hand opens by exactly that much.
  const openWidths = useRef({})
  const openWidth = focused != null && openWidths.current[cards[focused]?.id]
  // A lifted card stays up after the finger lifts, so it can be read, until the page scrolls or a touch lands
  // outside this hand.
  useEffect(() => {
    if (focused === null) return
    const settle = () => setFocused(null)
    const touchedElsewhere = (e) => !fanRef.current?.contains(e.target) && settle()
    addEventListener('scroll', settle, { passive: true })
    addEventListener('pointerdown', touchedElsewhere)
    return () => {
      removeEventListener('scroll', settle)
      removeEventListener('pointerdown', touchedElsewhere)
    }
  }, [focused])
  // The card under the pointer or finger is found from where the cards sit before any opens (offsetLeft ignores their
  // movement), not from what's drawn there: cards move as one opens, and picking by what's drawn bounced the opening
  // between neighbours.
  // While a card is dragged, no card opens: cards moving under it would throw off where it lands.
  const reordering = dragId != null
  useEffect(() => { if (reordering) setFocused(null) }, [reordering])
  function onPointer(e) {
    if (reordering) return
    const buttons = [...e.currentTarget.children]
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left + buttons[0].offsetLeft
    setFocused(Math.max(0, buttons.findLastIndex((button) => button.offsetLeft <= x)))
  }
  return (
    // A touch is tied to where it started; untied, a finger sliding on into another hand moves that hand instead, and
    // the hand it left (finger still down) settles. The browser taking over the touch (to scroll or zoom) settles it too.
    <div
      class="card-fan"
      ref={fanRef}
      style={openWidth ? { '--open-width': `calc(var(--fan-height) * ${openWidth})` } : undefined}
      onPointerDown={(e) => { e.target.releasePointerCapture?.(e.pointerId); onPointer(e) }}
      onPointerMove={onPointer}
      onPointerLeave={(e) => (e.pointerType !== 'touch' || e.buttons) && setFocused(null)}
      onPointerCancel={() => setFocused(null)}
    >
      {cards.map((card, index) => (
        <FanCard key={card.id} card={card} index={index} onShape={(width) => { openWidths.current[card.id] = width }} order={first + index} side={side} dragging={dragId === card.id} dragHandlers={dragHandlers?.(card.id)} focused={index === focused} pressed={selected ? selected.has(card.id) : undefined} onActivate={onActivate} />
      ))}
    </div>
  )
}

// Landscape cards are turned a quarter (the same way as a turned back in Card3D) so the whole row is portrait.
// Stickers stay as they are: a cut-out has no right way to lie on its side.
// Switching between fronts and backs flips each card in turn, first to last, this long after the one before.
const FLIP_STAGGER_MS = 35

// order: its place in the whole collection, so a flip runs on from one row into the next.
function FanCard({ card, index, order, side, focused, pressed, dragging, dragHandlers, onShape, onActivate }) {
  const shown = side === 'back' && card.back ? 'back' : 'front'
  // The side on screen, which follows `shown` by way of a flip: edge-on ('out'), swap photos, and once the other side's
  // has loaded, back ('in').
  const [face, setFace] = useState(shown)
  const [flip, setFlip] = useState(null)
  useEffect(() => {
    if (shown === face) return
    const timer = setTimeout(() => setFlip('out'), order * FLIP_STAGGER_MS)
    return () => clearTimeout(timer)
  }, [shown])
  function onAnimationEnd(e) {
    if (e.target !== e.currentTarget) return
    if (flip === 'in') setFlip(null)
    // Switched back before it got here: nothing new to load.
    else if (shown === face) setFlip('in')
    else setFace(shown)
  }
  const [landscape, setLandscape] = useState(false)
  // Whether it turns smoothly: only once a photo has been drawn the way it lies. Its shape is only known once it loads
  // (on opening the list, or switching between fronts and backs), and turning it then shouldn't animate.
  const [settled, setSettled] = useState(false)
  const [loads, setLoads] = useState(0)
  function onLoad(e) {
    const ratio = e.target.naturalWidth / e.target.naturalHeight
    const turned = card.kind !== 'sticker' && ratio > 1
    onShape(turned ? 1 : ratio)
    setSettled(false)
    setLandscape(turned)
    setLoads((count) => count + 1)
    // Only the new side's photo ends the flip: a refresh mid-flip also reloads the old side's, which mustn't.
    if (flip === 'out' && face === shown) setFlip('in')
  }
  useEffect(() => {
    if (!loads) return
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setSettled(true)) })
    return () => cancelAnimationFrame(frame)
  }, [loads])
  return (
    <button
      type="button"
      class={[focused && 'focused', landscape && 'landscape', settled && 'settled', card.kind === 'sticker' && 'sticker', flip && `flip-${flip}`, dragging && 'dragging'].filter(Boolean).join(' ')}
      aria-label={card.name ? t('Open {name}', { name: card.name }) : t('Open card')}
      aria-pressed={pressed}
      style={{ '--i': index }}
      onClick={() => onActivate(card)}
      onAnimationEnd={onAnimationEnd}
      {...dragHandlers}
    >
      <Thumbnail card={card} side={face} onLoad={onLoad} />
    </button>
  )
}

function Thumbnail({ card, side, onLoad }) {
  const [blob, setBlob] = useState(null)
  useEffect(() => {
    let current = true
    thumbnailFor(card.id, side, card[side], card.kind === 'sticker').then((made) => current && setBlob(made))
    return () => { current = false }
  }, [card[side]])
  return <CardImage blob={blob} className="thumb" style={card.kind === 'sticker' ? undefined : cornerStyle(card[`${side}Edit`])} onLoad={onLoad} lazy />
}

function daysSince(isoString) {
  return Math.floor((Date.now() - new Date(isoString).getTime()) / 86400000)
}

const CameraIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 8a2 2 0 0 1 2-2h2.5l1.5-2h6l1.5 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><circle cx="12" cy="13" r="3.5" /></svg>
)

const CardIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h6M7 14h4" stroke-linecap="round" /></svg>
)

const StickerIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" /></svg>
)

const CollageIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="13" height="9" rx="1.5" transform="rotate(-8 9.5 11.5)" /><rect x="8" y="9" width="13" height="9" rx="1.5" transform="rotate(6 14.5 13.5)" /></svg>
)

// Line icons for the photo toolbar, drawn like SF Symbols' outline style.
const GLYPHS = {
  crop: 'M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14',
  swap: 'M4 7h16M16 3l4 4-4 4M20 17H4M8 13l-4 4 4 4',
  plus: 'M12 5v14M5 12h14',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18h2',
}
const Glyph = ({ name }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={GLYPHS[name]} /></svg>
)

// A box with two cards peeking out; stands in for the "Cardbox" title.
// Days since the last backup or sync (Infinity if never) once a reminder is due, else null.
function overdueDays(cardCount, lastBackup) {
  if (cardCount < BACKUP_MIN_CARDS) return null
  const days = lastBackup ? daysSince(lastBackup) : Infinity
  return days > BACKUP_STALE_DAYS ? days : null
}

// Six digits, so a layout's number is easy to note down and type back in.
const newSeed = () => Math.floor(Math.random() * 1e6)

const ENCODE_DELAY_MS = 300
// A gentle table-top view to start from: nearer edge wider than the far one.
const DEFAULT_SURFACE = [{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.3 }, { x: 0.95, y: 0.9 }, { x: 0.05, y: 0.9 }]

// A shareable "card collage": the chosen cards scattered across one image, like a convention haul laid on a table.
function GroupPhoto({ cards, onClose }) {
  // 'kind:cards', 'kind:stickers' or 'kind:all', or 'event:<name>' for one collection with both kinds. Null until
  // picked: nothing is loaded before then, as laying out every card can take a while.
  const [choice, setChoice] = useState(null)
  const event = choice?.startsWith('event:') ? choice.slice('event:'.length) : ''
  const stickerCount = cards.filter((card) => card.kind === 'sticker').length
  // [value, label, cards]: the cards give the picker's tiles their pictures.
  const choices = [
    ['kind:all', t('Everything ({count})', { count: cards.length }), cards],
    ...(stickerCount > 0 ? [
      ['kind:cards', t('All cards ({count})', { count: cards.length - stickerCount }), cards.filter((card) => card.kind !== 'sticker')],
      ['kind:stickers', t('All stickers ({count})', { count: stickerCount }), cards.filter((card) => card.kind === 'sticker')],
    ] : []),
    ...collections(cards).filter(([name]) => name).map(([name, group]) => [`event:${name}`, `${name} (${group.length})`, group]),
  ]
  const [sides, setSides] = useState('front')
  const [aspect, setAspect] = useState(() => localStorage.getItem('collageAspect') || '1')
  const [tilt, setTilt] = useState(() => Number(localStorage.getItem('collageTilt') ?? DEFAULT_TILT))
  const [overlap, setOverlap] = useState(() => Number(localStorage.getItem('collageOverlap') ?? DEFAULT_OVERLAP))
  const [tidy, setTidy] = useState(() => localStorage.getItem('collageStyle') === 'tidy')
  const [gap, setGap] = useState(() => Number(localStorage.getItem('collageGap') ?? DEFAULT_TIDY_GAP))
  const [scale, setScale] = useState(() => Number(localStorage.getItem('collageScale') ?? 1))
  const [seed, setSeed] = useState(newSeed)
  const [adjusting, setAdjusting] = useState(false)
  // A photo (ImageBitmap) behind the cards, or null for the plain dark one.
  // 'colour' (a plain one, picked in the menu), 'transparent', or a photo (ImageBitmap).
  const [backdrop, setBackdrop] = useState('colour')
  const background = typeof backdrop === 'object' ? backdrop : null
  const [colour, setColour] = useState(() => localStorage.getItem('collageColour') || DEFAULT_FILL)
  const transparent = backdrop === 'transparent'
  function plainBackdrop(kind) {
    setBackdrop(kind)
    setSurface(null)
  }
  const backgroundMenuRef = useRef()
  async function pickBackground(event) {
    const [file] = event.target.files
    event.target.value = ''
    backgroundMenuRef.current.hidePopover()
    if (!file) return
    setBackdrop(await createImageBitmap(file))
    setSurface(null)
  }
  // Where the cards lie on the photo: four corners as shares of the image (see warpLayer), or null for flat.
  // corners: the same while dragging them, null when not adjusting.
  const [surface, setSurface] = useState(null)
  const [corners, setCorners] = useState(null)
  const [cv, setCv] = useState(null)
  useEffect(() => { if (surface && !cv) loadOpenCv().then((loaded) => setCv(() => loaded)) }, [surface])
  function fitSurface() {
    // The handles sit over the unzoomed canvas.
    canvasRef.current.style.transform = ''
    const start = surface ?? DEFAULT_SURFACE
    setCorners(start)
    // The Size slider goes with it: a warped pile often needs shrinking to sit on the table.
    setAdjusting(true)
    setSurface(start)
  }
  // Closes the Size slider opened with it, too.
  function stopFitting() {
    setCorners(null)
    setAdjusting(false)
  }
  // The canvas's place in the stage, for the handles over it.
  const [canvasBox, setCanvasBox] = useState(null)
  useEffect(() => {
    if (!corners) return
    const canvas = canvasRef.current
    const observer = new ResizeObserver(() => setCanvasBox({ left: canvas.offsetLeft, top: canvas.offsetTop, width: canvas.offsetWidth, height: canvas.offsetHeight }))
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [!!corners])
  // A corner may go past the photo's edge (a table's far corners are often out of shot), as far as the stage around it.
  function dragCorner(event, index) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const editor = event.currentTarget.parentElement
    const rect = editor.getBoundingClientRect()
    const stage = editor.parentElement.getBoundingClientRect()
    const within = (value, low, high) => Math.min(high, Math.max(low, value))
    const x = (within(event.clientX, stage.left, stage.right) - rect.left) / rect.width
    const y = (within(event.clientY, stage.top, stage.bottom) - rect.top) / rect.height
    setCorners(corners.map((corner, n) => (n === index ? { x, y } : corner)))
  }
  const [thumbnails, setThumbnails] = useState(null)
  const [image, setImage] = useState(null)
  const canvasRef = useRef()
  const zoomProps = usePinchZoom()
  const chosen = !choice ? []
    : event ? cards.filter((card) => card.collections.includes(event))
    : choice === 'kind:all' ? cards
    : cards.filter((card) => (card.kind === 'sticker') === (choice === 'kind:stickers'))

  useEffect(() => {
    if (!choice) return
    let cancelled = false
    setThumbnails(null)
    setImage(null)
    ;(async () => {
      const backed = chosen.filter((card) => card.back)
      const fronts = await loadThumbnails(chosen.map((card) => card.front))
      const backs = sides === 'front' ? [] : await loadThumbnails(backed.map((card) => card.back))
      const backOf = new Map(backs.map((thumbnail, i) => [backed[i], thumbnail]))
      let items = collageItems(chosen.map((card, i) => ({ front: fronts[i], back: sides === 'both' ? backOf.get(card) ?? null : null, frontRadius: card.frontEdit?.radius, backRadius: card.backEdit?.radius, sticker: card.kind === 'sticker', size: card.size })))
      // Backs are laid out by their fronts' shapes, so flipping between Fronts and Backs keeps every card in place.
      // A card with no back keeps showing its front.
      if (sides === 'back') {
        items = items.map((item, i) => (backOf.has(chosen[i]) ? { ...item, members: collageItems([{ front: backOf.get(chosen[i]), back: null, frontRadius: chosen[i].backEdit?.radius }])[0].members } : item))
      }
      if (!cancelled) setThumbnails(items)
    })()
    return () => { cancelled = true }
  }, [choice, sides])

  // Each layer is redone only when its own settings change, so dragging the colour picker just repaints the background.
  const cardLayer = useMemo(() => thumbnails && drawCards(thumbnails, seed, Number(aspect), { tilt, overlap, tidy, gap, scale }), [thumbnails, seed, aspect, tilt, overlap, tidy, gap, scale])
  const placedLayer = useMemo(() => (cardLayer && surface && cv ? warpLayer(cv, cardLayer, surface) : cardLayer), [cardLayer, surface, cv])
  useEffect(() => {
    if (!placedLayer) return
    setImage(null)
    composeCollage(canvasRef.current, placedLayer, { fill: transparent ? null : colour, background })
    // Encoded up front so Share runs straight from the tap; Safari refuses share() once the tap is stale. After a
    // pause, so a stream of changes (the colour picker, a slider) doesn't encode a full-size image for each one.
    // PNG only when see-through: JPEG has no transparency, and is far smaller otherwise.
    let current = true
    const timer = setTimeout(() => canvasRef.current.toBlob((blob) => current && setImage(blob), transparent ? 'image/png' : 'image/jpeg', 0.9), ENCODE_DELAY_MS)
    return () => { current = false; clearTimeout(timer) }
  }, [placedLayer, backdrop, colour])

  async function share() {
    const name = `cardbox-${(event || choice.replace('kind:', 'all-').replace('all-all', 'all')).replace(/[^\p{L}\p{N}]+/gu, '-')}.${image.type === 'image/png' ? 'png' : 'jpg'}`
    await shareFile(new File([image], name, { type: image.type }))
  }

  // Three cards fanned on each picker tile, picked at random once per visit; cards before stickers, so a collection
  // with both doesn't look like a sticker pile.
  const previews = useMemo(() => Object.fromEntries(choices.map(([value, , group]) => {
    const shuffled = [...group].sort(() => Math.random() - 0.5)
    return [value, shuffled.sort((a, b) => (a.kind === 'sticker') - (b.kind === 'sticker')).slice(0, 3)]
  })), [cards])
  if (!choice) {
    return (
      <main class="collage-choice">
        <BackHeader title={t('Card collage')} onBack={onClose} />
        <p class="muted">{t('Which cards go in the collage?')}</p>
        <div class="collage-tiles">
          {choices.map(([value, label, group]) => (
            <button type="button" class="collage-tile" key={value} onClick={() => setChoice(value)}>
              <span class="tile-stack" aria-hidden="true">
                {previews[value].map((card) => (
                  <span class={card.kind === 'sticker' ? 'tile-card sticker' : 'tile-card'} key={card.id}><Thumbnail card={card} side="front" /></span>
                ))}
              </span>
              <span class="tile-label">{label}</span>
            </button>
          ))}
        </div>
      </main>
    )
  }

  return (
    <div class="cropper group-photo-screen">
      {/* Back to the picker, where the cards are chosen. */}
      <BackHeader title={t('Card collage')} onBack={() => { setChoice(null); setCorners(null) }}>
        {corners
          ? <>
            <button type="button" class="nav-action" onClick={() => { setSurface(null); stopFitting() }}>{t('Reset')}</button>
            <button type="button" class="nav-action primary" onClick={stopFitting}>{t('Done')}</button>
          </>
          : <button type="button" class="nav-action" popovertarget="background-menu">{t('Background')}</button>}
      </BackHeader>
      {/* A popover, so a tap anywhere else closes it. Labels around the file inputs, so a pick opens the picker straight from the tap. */}
      <div id="background-menu" class="background-menu" popover ref={backgroundMenuRef}>
        {/* The swatch is the colour input itself, so a tap anywhere on the row opens the system picker. */}
        <label aria-pressed={backdrop === 'colour'}>
          {t('Solid colour')}
          <input
            type="color" class="background-swatch" value={colour}
            onClick={() => plainBackdrop('colour')}
            onInput={(e) => { setColour(e.target.value); localStorage.setItem('collageColour', e.target.value); plainBackdrop('colour') }}
          />
        </label>
        <button type="button" aria-pressed={transparent} onClick={() => { plainBackdrop('transparent'); backgroundMenuRef.current.hidePopover() }}>{t('Transparent')}</button>
        <label>{t('Take a photo')}<input type="file" accept="image/*" capture="environment" hidden onChange={pickBackground} /></label>
        <label>{t('Choose from library')}<input type="file" accept="image/*" hidden onChange={pickBackground} /></label>
      </div>
      <div class="cropper-stage">
        <canvas ref={canvasRef} class={`group-photo${corners ? ' fitting' : ''}${transparent ? ' see-through' : ''}`} {...(corners ? {} : zoomProps)} />
        {/* Drag the corners onto a table in the photo; the cards are warped to match once a corner is let go. */}
        {corners && canvasBox && (
          <div class="surface-editor" style={Object.fromEntries(Object.entries(canvasBox).map(([key, value]) => [key, `${value}px`]))}>
            <svg viewBox="0 0 1 1" preserveAspectRatio="none"><polygon points={corners.map(({ x, y }) => `${x},${y}`).join(' ')} /></svg>
            {corners.map(({ x, y }, index) => (
              <div
                key={index} class="surface-handle" style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
                onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
                onPointerMove={(e) => dragCorner(e, index)}
                onPointerUp={() => setSurface(corners)}
              />
            ))}
          </div>
        )}
        {!thumbnails && <div class="cropper-message">{chosen.length === 1 ? t('Laying out {count} card…', { count: 1 }) : t('Laying out {count} cards…', { count: chosen.length })}</div>}
      </div>
      <div class="segmented collage-style" role="radiogroup" aria-label={t('Style')}>
        {[['pile', t('Pile')], ['tidy', t('Tidy')]].map(([value, label]) => (
          <button
            type="button" key={value} role="radio" aria-checked={tidy === (value === 'tidy')}
            onClick={() => { setTidy(value === 'tidy'); localStorage.setItem('collageStyle', value) }}
          >{label}</button>
        ))}
      </div>
      <div class="group-photo-options">
        {background && <button type="button" class="collage-fit" aria-pressed={!!corners} onClick={corners ? stopFitting : fitSurface}>{t('Fit to surface')}</button>}
        <label class="collage-option">
          <span>{t('Sides')}</span>
          <select value={sides} onChange={(e) => setSides(e.target.value)}>
            <option value="front">{t('Fronts')}</option>
            <option value="back">{t('Backs')}</option>
            <option value="both">{t('Both')}</option>
          </select>
        </label>
        <label class="collage-option">
          <span>{t('Shape')}</span>
          <select value={aspect} onChange={(e) => { setAspect(e.target.value); localStorage.setItem('collageAspect', e.target.value) }}>
            <option value="1">1:1</option>
            <option value={String(4 / 5)}>4:5</option>
            <option value={String(9 / 16)}>9:16</option>
            <option value={String(5 / 4)}>5:4</option>
            <option value={String(16 / 9)}>16:9</option>
          </select>
        </label>
      </div>
      <div class={`collage-sliders${adjusting ? ' open' : ''}`}>
        {!tidy && <label class="slider">
          <span>{t('Tilt')}</span>
          <input type="range" min="0" max={MAX_TILT_LIMIT} step="1" value={tilt} onInput={(e) => { setTilt(Number(e.target.value)); localStorage.setItem('collageTilt', e.target.value) }} />
          <output>{tilt}°</output>
        </label>}
        {!tidy && <label class="slider">
          <span>{t('Overlap')}</span>
          <input type="range" min="0" max={MAX_OVERLAP_LIMIT * 100} step="1" value={Math.round(overlap * 100)} onInput={(e) => { setOverlap(e.target.value / 100); localStorage.setItem('collageOverlap', e.target.value / 100) }} />
          <output>{Math.round(overlap * 100)}%</output>
        </label>}
        {tidy && <label class="slider">
          <span>{t('Gap')}</span>
          <input type="range" min="0" max={MAX_TIDY_GAP * 100} step="0.5" value={gap * 100} onInput={(e) => { setGap(e.target.value / 100); localStorage.setItem('collageGap', e.target.value / 100) }} />
          <output>{gap * 100}%</output>
        </label>}
        <label class="slider">
          <span>{t('Size')}</span>
          <input type="range" min="40" max="100" step="5" value={Math.round(scale * 100)} onInput={(e) => { setScale(e.target.value / 100); localStorage.setItem('collageScale', e.target.value / 100) }} />
          <output>{Math.round(scale * 100)}%</output>
        </label>
        <label class="slider">
          <span>{t('Layout number')}</span>
          <input class="seed" inputmode="numeric" value={seed} onChange={(e) => { const value = parseInt(e.target.value, 10); if (value >= 0) setSeed(value); else e.target.value = seed }} />
        </label>
      </div>
      <div class="cropper-actions">
        <button type="button" class="icon-button" aria-label={t('Shuffle')} disabled={!thumbnails} onClick={() => setSeed(newSeed())}>↻</button>
        <button type="button" class="icon-button collage-adjust" aria-label={t('Adjust')} aria-pressed={adjusting} onClick={() => setAdjusting(!adjusting)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>
        </button>
        <button type="button" class="primary" disabled={!image} onClick={share}>{t('Share')}</button>
      </div>
    </div>
  )
}

// Runs a backup/scan action and reports how it went: [status, run]. run(action, successMessage) shows action's
// returned text, or successMessage, or the error; onChanged follows a success.
// A success message clears itself after a while; an error stays until the next action.
const STATUS_CLEAR_MS = 4000
function useRunner(onChanged) {
  const [status, setStatus] = useState('')
  async function run(action, successMessage) {
    try {
      const message = await action(setStatus) ?? successMessage
      setStatus(message)
      setTimeout(() => setStatus((current) => (current === message ? '' : current)), STATUS_CLEAR_MS)
    } catch (error) {
      if (error.name !== 'AbortError') setStatus(t('Failed: {message}', { message: error.message }))
      return
    }
    onChanged()
  }
  return [status, run]
}

// A drawer over the list (bottom sheet on phones). It has its own URL like a screen, so swipe-back closes it too.
// page 'sync' pushes the Sync panel inside the drawer, iOS Settings style; onClose then steps back to the main page.
// Offers a few real cards and stickers, so a first look at the app isn't an empty screen. Gives the size first (it's
// several MB, which matters on mobile data), then shows the download's progress. onLoaded(count) once imported.
function DemoDialog({ onClose, onLoaded }) {
  const dialogRef = useRef()
  const bytes = DEMO_BYTES
  const [percent, setPercent] = useState(null)
  const [error, setError] = useState(null)
  // { done, total } cards unpacked, once the download is in.
  const [importing, setImporting] = useState(null)
  // The imported cards, shown as a pack to open.
  const [pack, setPack] = useState(null)
  useEffect(() => {
    dialogRef.current.showModal()
  }, [])

  async function download() {
    setError(null)
    setPercent(0)
    try {
      const response = await fetch(DEMO_URL)
      if (!response.ok) throw new Error(t('Could not load the sample cards.'))
      const reader = response.body.getReader()
      const chunks = []
      let received = 0
      for (let chunk; !(chunk = await reader.read()).done;) {
        chunks.push(chunk.value)
        received += chunk.value.length
        setPercent(Math.min(100, Math.floor((received / bytes) * 100)))
      }
      setImporting({ done: 0, total: 0 })
      const ids = await importBackup(new Blob(chunks), (done, total) => setImporting({ done, total }))
      const cards = (await Promise.all(ids.map(getCard))).filter(Boolean)
      dialogRef.current.close()
      setPack(cards)
    } catch (failure) {
      setError(failure.message)
      setPercent(null)
      setImporting(null)
    }
  }

  const downloading = percent !== null
  if (pack) return <PackOpening cards={pack} name={t('Ranran')} onDone={() => onLoaded(pack.length)} />
  return (
    <dialog ref={dialogRef} class="alert" onCancel={(e) => { e.preventDefault(); if (!downloading) onClose() }}>
      <h2>{t('Download Ranran’s cards?')}</h2>
      <p class="muted">{error ?? t('{size} MB of cards and stickers, with the photos they were cropped from.', { size: (bytes / 1e6).toFixed(1) })}</p>
      {downloading
        ? (
          <>
            <progress class="beam-progress" max="100" value={importing?.total ? (importing.done / importing.total) * 100 : percent} />
            <p class="muted">{importing ? t('Saving cards… {done} of {total}', { done: importing.done, total: importing.total || '…' }) : t('Downloading… {percent}%', { percent })}</p>
          </>
        )
        : (
          <div class="alert-buttons">
            <button type="button" onClick={onClose}>{t('Cancel')}</button>
            <button type="button" class="primary" onClick={download}>{t('Download')}</button>
          </div>
        )}
    </dialog>
  )
}
const DEMO_URL = '/demo.zip'

function ImportButton({ run, class: className = '' }) {
  return (
    <label class={`button ${className}`}>
      {t('Import backup')}
      <input
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => {
          const file = e.target.files[0]
          e.target.value = ''
          if (file) run(async () => { const count = (await importBackup(file)).length; return count === 1 ? t('Imported {count} card', { count }) : t('Imported {count} cards', { count }) })
        }}
      />
    </label>
  )
}

const formatBytes = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`)

// How much space photos take, split like iOS's iPhone Storage bar; and, while older photos are still being turned
// into WebP in the background, how far that's got.
function PhotoStorage({ cards }) {
  const sizeOf = (photos) => photos.reduce((sum, photo) => sum + (photo instanceof Blob ? photo.size : 0), 0)
  const stickers = cards.filter((card) => card.kind === 'sticker')
  const named = cards.filter((card) => card.kind !== 'sticker')
  const segments = [
    { key: 'cards', label: t('Card photos'), bytes: sizeOf(named.flatMap((card) => [card.front, card.back])) },
    { key: 'stickers', label: t('Stickers'), bytes: sizeOf(stickers.map((card) => card.front)) },
    { key: 'originals', label: t('Originals'), bytes: sizeOf(cards.flatMap((card) => [card.frontOriginal, card.backOriginal])) },
  ].filter((segment) => segment.bytes > 0)
  const total = segments.reduce((sum, segment) => sum + segment.bytes, 0)
  const converted = cards.filter((card) => IMAGE_FIELDS.every((field) => !(card[field] instanceof Blob) || card[field].type === 'image/webp')).length
  return (
    <div class="storage">
      <div class="storage-head">
        <span>Cardbox</span>
        <span class="muted">{t('{size} used', { size: formatBytes(total) })}</span>
      </div>
      <div class="storage-bar">
        {segments.map((segment) => <span key={segment.key} class={`storage-${segment.key}`} style={{ flexGrow: segment.bytes }} />)}
      </div>
      <div class="storage-legend">
        {segments.map((segment) => <span key={segment.key}><i class={`storage-${segment.key}`} />{segment.label}</span>)}
      </div>
      {converted < cards.length && (
        <p class="muted storage-note">{t('Shrinking older photos to WebP… {converted} of {total}', { converted, total: cards.length })}</p>
      )}
    </div>
  )
}

function Settings({ cards, lastBackup, page, syncCode, onClose, onChanged, onSync, onReceive, onCollections, onTutorial }) {
  const overdue = overdueDays(cards.length, lastBackup)
  const [status, run] = useRunner(onChanged)
  const [demo, setDemo] = useState(false)
  const dialogRef = useRef()
  useEffect(() => { dialogRef.current.showModal() }, [])

  // Adds every QR code link found on each card's photos to its Social list, saving as it goes.
  async function scanAllQr(setStatus) {
    const { addQrSocials } = await import('./qr.js')
    const updated = await addQrSocials(cards, (index) => setStatus(t('Checking card photos: {current} of {total}…', { current: index + 1, total: cards.length })))
    return updated
      ? (updated === 1 ? t('Added QR links to {count} card.', { count: updated }) : t('Added QR links to {count} cards.', { count: updated }))
      : t('No new QR links found.')
  }

  return (
    <dialog
      ref={dialogRef}
      class="settings"
      // Esc: leave through onClose like the other ways out, which removes the dialog.
      onCancel={(e) => { e.preventDefault(); onClose() }}
      onClick={(e) => e.target === dialogRef.current && onClose()}
    >
      {page === 'sync' ? <div class="settings-page pushed" key="sync"><SyncScreen initialCode={syncCode} onDone={onClose} /></div>
      : page === 'collections' ? <div class="settings-page pushed" key="collections"><CollectionOrder cards={cards} onDone={onClose} /></div>
      : <div class="settings-page" key="main">
      <header class="list-header">
        <h1>{t('Settings')}</h1>
        <button type="button" class="icon-button" aria-label={t('Close')} onClick={onClose}>✕</button>
      </header>
      <section class="settings-group">
        <h2>{t('Backup & sync')}</h2>
        <div class="settings-list">
          {overdue !== null && (
            <div class="backup-warning">
              <span aria-hidden="true">⚠︎</span>
              <span>{overdue === Infinity ? t('Never backed up') : t('Last backup {days} days ago', { days: overdue })}<span class="muted"> · {t('photos live only on this device')}</span></span>
            </div>
          )}
          <button type="button" disabled={!cards.length} onClick={() => run(exportBackup, t('Backup exported'))}>{t('Export backup')}</button>
          <ImportButton run={run} />
          <button type="button" class="chevron" onClick={onSync}>{t('Sync with another device')}</button>
          <button type="button" class="chevron" onClick={onReceive}>{t('Scan QR code')}</button>
        </div>
        {overdue === null && cards.length > 0 && (
          <p class="settings-note">{!lastBackup ? t('Never backed up') : daysSince(lastBackup) ? t('Last backup or sync {days} days ago', { days: daysSince(lastBackup) }) : t('Last backup or sync today')}</p>
        )}
      </section>
      <section class="settings-group">
        <h2>{t('Cards')}</h2>
        <div class="settings-list">
          <button type="button" class="chevron" disabled={!cards.length} onClick={onCollections}>{t('Reorder collections')}</button>
          <button type="button" disabled={!cards.length} onClick={() => run(scanAllQr)}>{t('Find links in card photos')}</button>
        </div>
        <p class="settings-note">{t('Finds QR codes on your card photos and adds their links to each card’s Social list.')}</p>
      </section>
      {status && <p class="muted">{status}</p>}
      {demo && <DemoDialog onClose={() => setDemo(false)} onLoaded={(count) => { setDemo(false); run(() => t('Imported {count} cards', { count })) }} />}
      <section class="settings-group">
        <h2>{t('Help')}</h2>
        <div class="settings-list">
          <button type="button" class="chevron" onClick={onTutorial}>{t('How to use Cardbox')}</button>
          <button type="button" onClick={() => setDemo(true)}>{t('Download Ranran’s cards')}</button>
        </div>
      </section>
      <section class="settings-group">
        <h2>{t('Language')}</h2>
        <div class="settings-list">
          <label class="chevron">
            {t('Language')}
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              {Object.entries(LANGUAGES).map(([code, name]) => <option key={code} value={code} lang={code}>{name}</option>)}
            </select>
          </label>
        </div>
      </section>
      <section class="settings-group">
        <h2>{t('Storage')}</h2>
        <PhotoStorage cards={cards} />
      </section>
      <section class="settings-group">
        <h2>{t('Reset')}</h2>
        <div class="settings-list">
          <ArmedButton
            label={t('Clear all details')}
            armedLabel={t('Tap again to clear names, socials, collections and notes')}
            disabled={!cards.length}
            onConfirm={() => run(() => saveCards(cards.map((card) => ({ ...card, name: '', socials: [], collections: [], orders: {}, note: '' }))), t('Details cleared'))}
          />
          <ArmedButton
            label={t('Delete all cards')}
            armedLabel={t('Tap again to delete {count} cards and photos', { count: cards.length })}
            disabled={!cards.length}
            onConfirm={() => run(deleteAllCards, t('All cards deleted'))}
          />
        </div>
      </section>
      <p class="muted build">{t('Build {time}', { time: BUILD_TIME })}</p>
      </div>}
    </dialog>
  )
}

// tab: 'cards' or 'stickers', which kind of item the list shows (and what New shoots).
const COLLECTION_ORDER_KEY = 'collectionOrder'
const savedCollectionOrder = () => {
  try { return JSON.parse(localStorage.getItem(COLLECTION_ORDER_KEY)) ?? [] } catch { return [] }
}

// Cards by collection ('' for none), as [event, cards] in the order set in Settings → Reorder collections (kept on
// this device only), a card in several being in each. Collections not yet placed there come first, newest first, so a
// new one shows at the top. Newest is judged across `everything` (cards and stickers, unsearched), so the list, either
// tab, and the reorder sheet all agree.
function collections(cards, everything = cards) {
  const byEvent = new Map()
  for (const card of cards) {
    for (const event of card.collections.length ? card.collections : ['']) {
      if (!byEvent.has(event)) byEvent.set(event, [])
      byEvent.get(event).push(card)
    }
  }
  const order = savedCollectionOrder()
  const newestIn = new Map()
  for (const card of everything) {
    for (const event of card.collections.length ? card.collections : ['']) {
      if (card.createdAt > (newestIn.get(event) ?? '')) newestIn.set(event, card.createdAt)
    }
  }
  const newest = ([event]) => newestIn.get(event) ?? ''
  return [...byEvent].sort((a, b) => {
    const placeA = order.indexOf(a[0])
    const placeB = order.indexOf(b[0])
    if ((placeA < 0) !== (placeB < 0)) return placeA < 0 ? -1 : 1
    return placeA < 0 ? newest(b).localeCompare(newest(a)) : placeA - placeB
  })
}

// The collections checklist for the cards picked in Select mode. Each collection is ticked when all of them are in it,
// marked when some are; tapping puts all of them in it, or (when ticked) takes all of them out.
function CollectionSheet({ chosen, events, onToggle, onClose }) {
  const dialogRef = useRef()
  const [creating, setCreating] = useState(false)
  // The collections as they were on opening, plus any made here: one emptied here stays listed, to tick again.
  const [names, setNames] = useState(events)
  const listed = [...new Set([...names, ...events])]
  useEffect(() => { dialogRef.current.showModal() }, [])
  return (
    <dialog
      ref={dialogRef}
      class="collection-sheet"
      onCancel={(e) => { e.preventDefault(); onClose() }}
      onClick={(e) => e.target === dialogRef.current && onClose()}
    >
      <header class="list-header">
        <h2>{t('Collections for {count}', { count: chosen.length })}</h2>
        <button type="button" class="nav-action" onClick={onClose}>{t('Done')}</button>
      </header>
      <div class="settings-list">
        {listed.map((name) => {
          const inIt = chosen.filter((card) => card.collections.includes(name)).length
          const all = inIt === chosen.length
          return (
            <button type="button" key={name} role="checkbox" aria-checked={all ? 'true' : inIt ? 'mixed' : 'false'} onClick={() => onToggle(name, !all)}>
              <span>{name}</span>
              <span class="check" aria-hidden="true">{all ? '✓' : inIt ? '–' : ''}</span>
            </button>
          )
        })}
        {creating
          ? <NewCollectionInput onDone={(name) => { setCreating(false); if (name) { setNames([...names, name]); onToggle(name, true) } }} />
          : <button type="button" class="add-social" onClick={() => setCreating(true)}><span class="row-add" aria-hidden="true">+</span>{t('New collection…')}</button>}
      </div>
    </dialog>
  )
}

// Settings → Reorder collections: drag the collections' names into the order the list shows them in.
function CollectionOrder({ cards, onDone }) {
  const [events, setEvents] = useState(() => collections(cards).map(([event]) => event))
  const counts = useMemo(() => Object.fromEntries(collections(cards).map(([event, group]) => [event, group.length])), [cards])
  const { drag, rowProps } = useReorder((order) => {
    localStorage.setItem(COLLECTION_ORDER_KEY, JSON.stringify(order))
    setEvents(order)
  })
  return (
    <div class="collection-order">
      <BackHeader title={t('Reorder collections')} onBack={onDone} />
      <div class="settings-list">
        {(drag ? drag.ids : events).map((event) => (
          // A group key no collection can be called, so these rows never mix with cards' own reordering.
          <div key={event} class={drag?.id === event ? 'collection-row dragging' : 'collection-row'} {...rowProps('\u0000collections', events, event)}>
            <span>{event || t('No collection')}</span>
            <span class="muted">{counts[event]}</span>
          </div>
        ))}
      </div>
      <p class="settings-note">{t('Drag to reorder. New collections appear at the top.')}</p>
    </div>
  )
}

function List({ cards: items, tab, onTab, events, lastBackup, storageBroken, onOpen, onRapid, onGroupPhoto, onSettings, onSync, onChanged }) {
  const cards = items.filter((item) => (item.kind === 'sticker') === (tab === 'stickers'))
  const [query, setQuery] = useState('')
  // Which side of each card the list shows: 'both', 'front' or 'back'. Stickers have only a front.
  const [sides, setSides] = useState(() => localStorage.getItem('listSides') || 'both')
  const chooseSides = (next) => { localStorage.setItem('listSides', next); setSides(next) }
  const shownSides = tab === 'stickers' ? 'front' : sides
  // Compact: each collection as one overlapping row, like a hand of cards.
  const [compact, setCompact] = useState(() => localStorage.getItem('listLayout') !== 'grid')
  const cardsPerFan = useCardsPerFan()
  const toggleCompact = () => { localStorage.setItem('listLayout', compact ? 'grid' : 'compact'); setCompact(!compact) }
  const [status, run] = useRunner(onChanged)
  const [demo, setDemo] = useState(false)
  const backupDue = overdueDays(items.length, lastBackup) !== null
  // Select mode, for moving many cards to an event at once: null when off, else the set of chosen card ids.
  const [selected, setSelected] = useState(null)
  // Whether the collections checklist for the selected cards is open.
  const [filing, setFiling] = useState(false)
  const selecting = selected !== null
  const activate = (card) => (selecting
    ? setSelected((current) => {
      const next = new Set(current)
      if (!next.delete(card.id)) next.add(card.id)
      return next
    })
    : onOpen(card.id))
  const toggle = (ids, on) => setSelected((current) => {
    const next = new Set(current)
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)))
    return next
  })
  // Puts every selected card in the collection (at its top, as if just added), or takes every one out of it.
  async function fileSelected(event, on) {
    const changed = cards.filter((card) => selected.has(card.id) && card.collections.includes(event) !== on)
    await saveCards(changed.map((card) => {
      const { [event]: _, ...orders } = card.orders
      return { ...card, collections: on ? [...card.collections, event] : card.collections.filter((name) => name !== event), orders }
    }))
    onChanged()
  }
  const { drag, rowProps } = useReorder(async (ids, event) => {
    await saveCards(ids.map((id, place) => {
      const card = cards.find((other) => other.id === id)
      return { ...card, orders: { ...card.orders, [event]: place } }
    }))
    onChanged()
  })
  // Reordering a filtered subset would be ambiguous, so it's off while searching.
  const canDrag = !selecting && !query.trim()

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return collections(cards.filter((card) => !needle || searchText(card).includes(needle)), items)
      .map(([event, group]) => [event, group.sort(compareInGroup(event))])
  }, [cards, query])

  return (
    <main class={`list ${tab}${tab === 'cards' && sides !== 'both' ? ' one-side' : ''}`}>
      {storageBroken && (
        <p class="storage-warning" role="alert"><span aria-hidden="true">⚠︎</span> {t('This browser can’t save cards here, which happens in private browsing. Open Cardbox in a normal tab.')}</p>
      )}
      {/* Stays at the top while the cards scroll under it. */}
      <div class="list-top">
      <header class="list-header">
        {/* Empty, the big logo in the middle stands in for this one. */}
        <h1 class="logo">{items.length > 0 && <Logo />}</h1>
        {/* The bottom bar holds the tabs and New, so Collage sits up here, as the one filled button. */}
        {!selecting && cards.length > 0 && <button type="button" class="nav-action collage-button" onClick={onGroupPhoto}><CollageIcon />{t('Collage')}</button>}
        {cards.length > 0 && (
          <button type="button" class="nav-action" onClick={() => setSelected(selecting ? null : new Set())}>
            {selecting ? t('Done') : t('Select')}
          </button>
        )}
        {!selecting && (
          <button type="button" class="nav-action nav-icon" aria-label={backupDue ? t('Settings (backup due)') : t('Settings')} onClick={onSettings}>
            {backupDue && <span class="badge" />}
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          </button>
        )}
      </header>
      {items.length > 0 && (
        <div class="list-tools">
        <label class="search-field">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21" /></svg>
          <input
            type="search"
            aria-label={t('Search')}
            placeholder={t('Search names, collections, notes')}
            value={query}
            onInput={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          />
        </label>
        {cards.length > 0 && (
          <button type="button" class="icon-button list-layout" aria-label={t('Compact view')} aria-pressed={compact} onClick={toggleCompact}>
            {compact
              ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="11" height="15" rx="2" /><path d="M8 5V4a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-3" /><path d="M14 2.5a2 2 0 0 1 2-.5h3a2 2 0 0 1 2 2v12" /></svg>
              : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>}
          </button>
        )}
        {tab === 'cards' && cards.length > 0 && (
          <div class="segmented" role="radiogroup" aria-label={t('Sides')}>
            {/* A compact hand shows one side of each card, so there's no Both: Both shows fronts there. */}
            {[['both', t('Both')], ['front', t('Fronts')], ['back', t('Backs')]].filter(([value]) => !compact || value !== 'both').map(([value, label]) => (
              <button type="button" key={value} role="radio" aria-checked={(compact && sides === 'both' ? 'front' : sides) === value} onClick={() => chooseSides(value)}>{label}</button>
            ))}
          </div>
        )}
        </div>
      )}
      </div>
      {groups.map(([event, group]) => (
        <section key={event}>
          <div class="group-heading">
            <h2>{event || t('No collection')} <span class="group-count">{group.length}</span></h2>
            {selecting && (() => {
              const ids = group.map((card) => card.id)
              const all = ids.every((id) => selected.has(id))
              return <button type="button" class="nav-action" onClick={() => toggle(ids, !all)}>{all ? t('Clear') : t('Select all')}</button>
            })()}
          </div>
          {compact ? (
            // A collection that fits in one hand spreads out to fill the row (spaced as if three at least, which the
            // opening maths needs); one that wraps keeps every row spaced alike.
            <div class="card-fans" style={{ '--cards-per-fan': group.length < cardsPerFan ? Math.max(3, group.length) : cardsPerFan }}>
              {Array.from({ length: Math.ceil(group.length / cardsPerFan) }, (_, i) => (
                <CardFan
                  key={i}
                  cards={(drag?.group === event ? drag.ids.map((id) => group.find((card) => card.id === id)) : group).slice(i * cardsPerFan, (i + 1) * cardsPerFan)}
                  first={i * cardsPerFan}
                  dragId={drag?.id}
                  dragHandlers={canDrag ? (id) => rowProps(event, group.map((other) => other.id), id) : null}
                  side={shownSides === 'back' ? 'back' : 'front'}
                  selected={selected}
                  onActivate={activate}
                />
              ))}
            </div>
          ) : <div class="card-rows">
            {(drag?.group === event ? drag.ids.map((id) => group.find((card) => card.id === id)) : group).map((card) => (
              <CardRow
                key={card.id}
                card={card}
                sides={shownSides}
                pressed={selecting ? selected.has(card.id) : undefined}
                dragging={drag?.id === card.id}
                dragHandlers={canDrag ? rowProps(event, group.map((other) => other.id), card.id) : null}
                onActivate={() => activate(card)}
              />
            ))}
          </div>}
        </section>
      ))}
      {!groups.length && cards.length > 0 && <p class="muted">{t('No matches.')}</p>}
      {items.length > 0 && !cards.length && (
        <div class="empty-state">
          <h2>{tab === 'stickers' ? t('No stickers') : t('No cards')}</h2>
          <p class="muted">{tab === 'stickers' ? t('Shoot stickers one at a time; each is cut out along its edge.') : t('Photograph your stack: front, back, next card.')}</p>
          <button type="button" class="glass" onClick={onRapid}><CameraIcon />{tab === 'stickers' ? t('New stickers') : t('New cards')}</button>
        </div>
      )}
      {!items.length && (
        <div class="empty-state">
          <Logo />
          <h2>{t('No cards or stickers yet')}</h2>
          <p class="muted">{t('Photograph the cards and stickers you collect, or receive one beamed from another phone. You can also bring them over from a backup or another device.')}</p>
          <button type="button" class="primary" onClick={onRapid}><CameraIcon />{t('Take photos or scan a QR code')}</button>
          <button type="button" class="glass" onClick={() => setDemo(true)}>{t('Download Ranran’s cards')}</button>
          <ImportButton run={run} class="glass" />
          <button type="button" class="glass" onClick={onSync}>{t('Sync from another device')}</button>
          <LanguageSwitch class="empty-language" />
        </div>
      )}
      {demo && <DemoDialog onClose={() => setDemo(false)} onLoaded={(count) => { setDemo(false); run(() => t('Imported {count} cards', { count })) }} />}
      {status && <p class="muted">{status}</p>}
      {selecting
        ? (
          <nav class="action-bar">
            <button type="button" disabled={!selected.size} onClick={() => setFiling(true)}>
              {selected.size ? t('Collections for {count}', { count: selected.size }) : t('Tap cards to select')}
            </button>
            {filing && (
              <CollectionSheet
                chosen={cards.filter((card) => selected.has(card.id))}
                events={events}
                onToggle={fileSelected}
                onClose={() => setFiling(false)}
              />
            )}
          </nav>
        )
        : items.length > 0 && (
          <nav class="action-bar">
            <div class="tab-bar" role="tablist">
              {[['cards', t('Cards'), CardIcon], ['stickers', t('Stickers'), StickerIcon]].map(([value, label, Icon]) => (
                <button type="button" key={value} role="tab" aria-selected={tab === value} class="toolbar-item" onClick={() => onTab(value)}>
                  <Icon />
                  {label}
                  {value === 'stickers' && <Beta />}
                </button>
              ))}
            </div>
            <button type="button" class="toolbar-item" aria-label={t('New')} onClick={onRapid}>
              <CameraIcon />
            </button>
          </nav>
        )}
    </main>
  )
}

function Fields({ values, setValues, events }) {
  const bind = (key) => ({ value: values[key], onInput: (e) => setValues({ ...values, [key]: e.target.value }) })
  const setSocials = (socials) => setValues({ ...values, socials: socials.length ? socials : [''] })
  return (
    <>
      <div class="settings-list">
        <label class="field-row">{t('Name')}<input {...bind('name')} /></label>
        <div class="field-row">{t('Collection')}<CollectionChips value={values.collections} events={events} onChange={(collections) => setValues({ ...values, collections })} /></div>
      </div>
      <section class="settings-group">
        <h2>{t('Social')}</h2>
        <div class="settings-list">
          {values.socials.map((social, index) => {
            const { href } = describeSocial(social)
            return (
              <div class="social-row" key={index}>
                {(social || values.socials.length > 1) && (
                  <button type="button" class="row-remove" aria-label={t('Remove')} onClick={() => setSocials(values.socials.filter((_, i) => i !== index))}>−</button>
                )}
                <input
                  aria-label={t('Social')}
                  placeholder={t('@handle or link')}
                  autocapitalize="off"
                  autocorrect="off"
                  value={social}
                  onInput={(e) => setSocials(values.socials.map((old, i) => (i === index ? e.target.value : old)))}
                />
                {href && (
                  <a href={href} target="_blank" rel="noopener noreferrer" aria-label={t('Open link')}>↗</a>
                )}
              </div>
            )
          })}
          <button type="button" class="add-social" onClick={() => setSocials([...values.socials, ''])}>
            <span class="row-add" aria-hidden="true">+</span>{t('Add social')}
          </button>
        </div>
      </section>
      <div class="settings-list">
        <label class="field-row stacked">{t('Note')}<textarea rows="3" {...bind('note')} /></label>
      </div>
    </>
  )
}

const emptyValues = { name: '', socials: [''], collections: [], note: '' }
const valuesOf = (card) =>
  Object.fromEntries(Object.entries(emptyValues).map(([key, empty]) => [key, card[key]?.length ? card[key] : empty]))
const cleanValues = (values) => ({
  ...values, socials: values.socials.map((social) => social.trim()).filter(Boolean),
})

function Detail({ card, events, onDone, onRefresh, setLeaveGuard }) {
  // { name: 'front' | 'back', original, edit } while the crop editor is open.
  const [editing, setEditing] = useState(null)
  const editSide = (name) => setEditing({ name, ...sideOf(card, name) })
  // The side ('front' | 'back') a new photo is being taken for, while the camera is open.
  const [retaking, setRetaking] = useState(null)
  const [values, setValues] = useState(() => valuesOf(card))
  // The side the 3D card is showing; the photo actions apply to it.
  const [side, setSide] = useState('front')
  const [status, setStatus] = useState(null)
  const sticker = card.kind === 'sticker'
  const [beaming, setBeaming] = useState(false)
  // A sticker's size in collages, as a share of a card's long side. Shown live while dragging, saved on release.
  const [size, setSize] = useState(card.size ?? DEFAULT_STICKER_SIZE)
  async function saveSize(value) {
    await saveCard({ ...card, size: value })
    onRefresh()
  }

  async function scanQr() {
    setStatus(t('Scanning…'))
    try {
      const { newSocialsFromQr } = await import('./qr.js')
      const { found, added } = await newSocialsFromQr(card, values.socials)
      if (added.length) setValues({ ...values, socials: [...values.socials.filter((social) => social.trim()), ...added] })
      setStatus(!found ? t('No QR code found.') : added.length ? t('Added {count} to Social.', { count: added.length }) : t('Already in Social.'))
    } catch (error) {
      setStatus(t('Could not scan: {message}', { message: error.message }))
    }
  }

  // A sticker's new photo is cut out straight away; a failed cut-out falls back to a rectangle crop, as when shooting.
  async function retakeSticker(original) {
    setStatus(t('Cutting out…'))
    try {
      const side = await cutOutSticker(await loadOpenCv(), original)
      await saveCard({ ...card, ...sideFields('front', side) })
      setStatus(side.detected ? null : t('No outline found; cropped as a rectangle.'))
      onRefresh()
    } catch (error) {
      setStatus(t('Could not cut out: {message}', { message: error.message }))
    }
  }

  // Text edits wait for Save; photo changes (retake, crop, swap, size) save straight away and leave them pending.
  const dirty = JSON.stringify(cleanValues(values)) !== JSON.stringify(cleanValues(valuesOf(card)))
  const confirmDiscard = () => confirm(t('Discard unsaved changes?'))
  useEffect(() => {
    setLeaveGuard(dirty ? confirmDiscard : null)
    // A crop or retake in progress isn't saved yet either, so an update waits for it.
    if (editing) setUnsavedWork(true)
  }, [dirty, editing])
  async function save() {
    await saveCard({ ...card, ...cleanValues(values) })
    onRefresh()
  }

  async function swapSides() {
    await saveCard({ ...card, ...sideFields('front', sideOf(card, 'back')), ...sideFields('back', sideOf(card, 'front')) })
    onRefresh()
  }


  if (beaming) return <BeamSend card={card} onClose={() => setBeaming(false)} />
  return (
    <main class="detail">
      <BackHeader title={card.name || (sticker ? t('Sticker') : t('Card'))} onBack={() => (!dirty || confirmDiscard()) && onDone()}>
        <button type="button" class="icon-button" aria-label={t('Beam by QR')} onClick={() => setBeaming(true)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m7.5 7.5 4.5-4.5 4.5 4.5" /><path d="M8 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-2" /></svg>
        </button>
        {dirty && <button type="button" class="nav-action primary" onClick={save}>{t('Save')}</button>}
      </BackHeader>
      {retaking && (
        <Camera
          initialMode={sticker ? 'stickers' : 'cards'}
          single
          onCancel={() => setRetaking(null)}
          onFinish={(original) => {
            setRetaking(null)
            if (sticker) retakeSticker(original)
            else setEditing({ name: retaking, original, edit: null })
          }}
        />
      )}
      {editing && (
        <CornerEditor
          original={editing.original}
          edit={editing.edit}
          sticker={sticker}
          onCancel={() => setEditing(null)}
          onDone={async ({ image, edit }) => {
            await saveCard({ ...card, ...sideFields(editing.name, { image, original: editing.original, edit }) })
            setEditing(null)
            onRefresh()
          }}
        />
      )}
      <div class="detail-media">
        {sticker
          ? <Card3D front={card.front} sticker size={size} layoutSize={card.size ?? DEFAULT_STICKER_SIZE} />
          : <Card3D front={card.front} back={card.back} frontEdit={card.frontEdit} backEdit={card.backEdit} onSideChange={setSide} />}
        {card.back && <p class="muted hint">{t('Drag to spin, tap to flip.')}</p>}
        {sticker && (
          <div class="photo-tools">
            <button type="button" onClick={() => setRetaking('front')}><CameraIcon />{t('Retake')}</button>
            <button type="button" onClick={() => editSide('front')}><Glyph name="crop" />{t('Adjust')}</button>
            <button type="button" disabled={status === t('Scanning…')} onClick={scanQr}><Glyph name="qr" />{t('Scan QR')}</button>
          </div>
        )}
        {sticker && (
          <label class="slider">
            <span>{t('Collage size')}</span>
            <input
              type="range" min="20" max="100" step="5"
              value={Math.round(size * 100)}
              onInput={(e) => setSize(e.target.value / 100)}
              onChange={(e) => saveSize(e.target.value / 100)}
            />
            <output>{Math.round(size * 100)}%</output>
          </label>
        )}
        {!sticker && (
          <div class="photo-tools">
            <button type="button" onClick={() => editSide(side)}><Glyph name="crop" />{side === 'front' ? t('Edit front') : t('Edit back')}</button>
            <button type="button" onClick={() => setRetaking(side)}><CameraIcon />{side === 'front' ? t('Retake front') : t('Retake back')}</button>
            {card.back
              ? <button type="button" onClick={swapSides}><Glyph name="swap" />{t('Swap sides')}</button>
              : <button type="button" onClick={() => setRetaking('back')}><Glyph name="plus" />{t('Add back')}</button>}
            <button type="button" disabled={status === t('Scanning…')} onClick={scanQr}><Glyph name="qr" />{t('Scan QR')}</button>
          </div>
        )}
        {status && <p class="muted hint">{status}</p>}
      </div>
      <form>
        <Fields values={values} setValues={setValues} events={events} />
        <div class="settings-list">
          <ArmedButton label={t('Delete')} armedLabel={t('Tap again to delete')} onConfirm={async () => { await deleteCard(card.id); onDone() }} />
        </div>
      </form>
    </main>
  )
}

// Each screen has its own URL fragment, so the browser's back button and swipe-back move between screens, and a
// reload stays on the same screen.
function viewFromHash() {
  const fragment = location.hash.slice(1)
  if (fragment.startsWith('card/')) return { name: 'detail', id: decodeURIComponent(fragment.slice('card/'.length)) }
  if (fragment === 'sync' || fragment.startsWith('sync/')) return { name: 'sync', code: fragment.slice('sync/'.length) || null }
  if (fragment.startsWith('receive/')) return { name: 'receive', code: fragment.slice('receive/'.length) }
  // A bare #receive was the old scanner screen; the camera's QR mode does that now.
  if (fragment === 'receive') return { name: 'scan' }
  if (['rapid', 'scan', 'group', 'settings', 'collections'].includes(fragment)) return { name: fragment }
  return { name: 'list' }
}
const hashOf = (view) => (view.name === 'detail' ? `#card/${encodeURIComponent(view.id)}` : `#${view.name}`)

export function App() {
  const [view, setView] = useState(viewFromHash)
  const [cards, setCards] = useState(null)
  const [lastBackup, setLastBackup] = useState(null)
  const [storageBroken, setStorageBroken] = useState(false)
  useEffect(() => { canStorePhotos().then((works) => setStorageBroken(!works)) }, [])
  const viewRef = useRef(view)
  viewRef.current = view
  // Whether the current screen was opened from the list in this visit, so leaving it can step back in history
  // rather than adding a new entry (which would make Back return to the screen just left).
  const openedFromListRef = useRef(false)
  // The page scroll is shared by every screen: a full screen opens at its top, and the list comes back where it was.
  const listScrollRef = useRef(0)
  // Which tab the list is on; New shoots that kind too.
  const [tab, setTab] = useState(() => (localStorage.getItem('listTab') === 'stickers' ? 'stickers' : 'cards'))
  const chooseTab = (next) => { localStorage.setItem('listTab', next); setTab(next); scrollTo(0, 0) }
  const [tutorial, setTutorial] = useState(() => !tutorialSeen())
  useLayoutEffect(() => {
    if (view.name === 'list') scrollTo(0, listScrollRef.current)
    else if (!['settings', 'sync', 'collections'].includes(view.name)) scrollTo(0, 0)
  }, [view.name, view.id])
  // Set by a screen holding unsaved photos; returns false to stay when the user swipes or presses Back.
  const leaveGuardRef = useRef(null)
  const leavingRef = useRef(false)

  async function refresh() {
    setCards(await listCards())
    setLastBackup((await getLastBackup()) ?? null)
  }
  useEffect(() => {
    refresh()
    // Older photos shrink to WebP in the background; Settings shows how far it's got.
    convertPhotosToWebp(refresh)
      .then(() => measureOldCorners(refresh))
      .catch((error) => console.warn('Photo upkeep stopped', error))
  }, [])

  useEffect(() => {
    function onHashChange() {
      const next = viewFromHash()
      if (!leavingRef.current && leaveGuardRef.current && !leaveGuardRef.current()) {
        // Undo the browser's step back by putting the current screen's URL back.
        history.pushState(null, '', hashOf(viewRef.current))
        return
      }
      leavingRef.current = false
      leaveGuardRef.current = null
      setUnsavedWork(false)
      setView(next)
      // The settings drawer sits over the list, so coming back to it (e.g. from Sync) shows fresh cards too.
      if (next.name === 'list' || next.name === 'settings') refresh()
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  function open(next) {
    if (view.name === 'list') listScrollRef.current = scrollY
    openedFromListRef.current = true
    location.hash = hashOf(next)
  }

  // In-app Back, Cancel, Done, Save: return to the list without asking.
  function leave() {
    leavingRef.current = true
    if (openedFromListRef.current) return history.back()
    // Arrived straight on this screen (a reload or a link): there's no list entry behind it to step back to.
    history.replaceState(null, '', location.pathname + location.search)
    leavingRef.current = false
    leaveGuardRef.current = null
    setUnsavedWork(false)
    setView({ name: 'list' })
    refresh()
  }
  const setLeaveGuard = (guard) => { leaveGuardRef.current = guard; setUnsavedWork(!!guard) }
  // Sync and Reorder collections sit one level inside the settings drawer, so leaving goes back to the drawer, even
  // when a scanned sync link opened Sync directly.
  function backToSettings() {
    if (openedFromListRef.current) return leave()
    history.replaceState(null, '', '#settings')
    setView({ name: 'settings' })
    refresh()
  }

  if (!cards) return null
  const events = [...new Set(cards.flatMap((card) => card.collections))]

  if (view.name === 'rapid' || view.name === 'scan') return <RapidCapture events={events} mode={view.name === 'scan' ? 'qr' : tab} onDone={leave} onChanged={refresh} onCode={async (hash) => { await refresh(); history.replaceState(null, '', hash); setView(viewFromHash()) }} setLeaveGuard={setLeaveGuard} />
  if (view.name === 'group') return <GroupPhoto cards={cards} onClose={leave} />
  // The received card replaces the Receive screen in history, so Back from it doesn't reopen the camera.
  // A scanned sync link replaces it the same way, so Back from Sync returns to where the scanner was opened.
  if (view.name === 'receive') {
    return (
      <BeamReceive
        code={view.code}
        onClose={leave}
        onDone={async (id) => { await refresh(); history.replaceState(null, '', hashOf({ name: 'detail', id })); setView({ name: 'detail', id }) }}
      />
    )
  }
  if (view.name === 'detail') {
    const card = cards.find((candidate) => candidate.id === view.id)
    if (card) return <Detail card={card} events={events} onDone={leave} onRefresh={refresh} setLeaveGuard={setLeaveGuard} />
  }
  return (
    <>
      <List
        cards={cards}
        tab={tab}
        onTab={chooseTab}
        events={events}
        lastBackup={lastBackup}
        storageBroken={storageBroken}
        onOpen={(id) => open({ name: 'detail', id })}
        onRapid={() => open({ name: 'rapid' })}
        onGroupPhoto={() => open({ name: 'group' })}
        onSettings={() => open({ name: 'settings' })}
        onSync={() => open({ name: 'sync' })}
        onChanged={refresh}
      />
      {['settings', 'sync', 'collections'].includes(view.name) && (
        <Settings
          cards={cards}
          lastBackup={lastBackup}
          page={view.name === 'settings' ? 'main' : view.name}
          syncCode={view.code}
          onClose={view.name === 'settings' ? leave : backToSettings}
          onChanged={refresh}
          onSync={() => open({ name: 'sync' })}
          onReceive={() => open({ name: 'scan' })}
          onCollections={() => open({ name: 'collections' })}
          onTutorial={() => setTutorial(true)}
        />
      )}
      {tutorial && <Tutorial onDone={() => setTutorial(false)} />}
    </>
  )
}
