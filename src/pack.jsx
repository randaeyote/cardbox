import { useEffect, useRef, useState } from 'preact/hooks'
import { t } from './i18n.js'
import { CardImage, Logo, cardCornerStyle } from './ui.jsx'
import { DEFAULT_STICKER_SIZE } from './collage.js'
import { Card3D } from './card3d.jsx'

// How far (as a share of the pack's width) a finger has to slide sideways to tear it open. The slide can start
// anywhere on screen: aiming at the pack's top on a phone is too fiddly.
const TEAR_DISTANCE = 0.35
// Dragging the stack tilts it in 3D to show its edge; let go after a sideways drag at least this long (px) and the top
// card flicks away. A tap also moves on; a shorter drag springs back.
const FLICK_DISTANCE = 90
const TAP_DISTANCE = 6
const TILT_PER_PIXEL = 0.35
const MAX_TILT = 40
// Flat at rest; it only tilts while held.
const REST_TILT = { x: 0, y: 0 }
// Cards drawn in the stack: enough to give it a visible thickness.
const STACK_SHOWN = 8
// The tear, plus the cards sliding up out of the pack (pack-rise) before it drops away.
const TEAR_MS = 1000
const FLICK_MS = 320
// Matches .pack-grid's gap.
const GRID_GAP = 12
// When the summary appears, the cards flip to their backs one after another, then, a moment after the last is over, back again.
// FLIP_MS matches Card3D's.
const FLIP_START_MS = 350
const FLIP_STAGGER_MS = 150
const FLIP_MS = 800
const FLIP_PAUSE_MS = 200
// A sticker's long side as a share of a card's, as in collages, so it isn't shown card-sized.
const scaleOf = (card) => (card.kind === 'sticker' ? card.size ?? DEFAULT_STICKER_SIZE : 1)

// A sealed foil pack holding newly added cards: slide a finger along its top to tear it open, then flick through the
// cards one at a time, ending on all of them laid out together. name: whose cards (on the pack's front).
export function PackOpening({ cards, name, onDone }) {
  const dialogRef = useRef()
  useEffect(() => { dialogRef.current.showModal() }, [])
  // Cards first, stickers last.
  const [ordered] = useState(() => [...cards.filter((card) => card.kind !== 'sticker'), ...cards.filter((card) => card.kind === 'sticker')])
  // sealed → torn (the top flying off) → revealing → summary.
  const [stage, setStage] = useState('sealed')
  const [tear, setTear] = useState(0)
  // Which way the finger slides, either works; the strip tears off from the end it starts at.
  const [tearLeft, setTearLeft] = useState(false)
  // Whether the screen has been touched yet; the swipe hint shows until then.
  const [touched, setTouched] = useState(false)
  const startRef = useRef(null)
  const [index, setIndex] = useState(0)
  // Ids of the landscape cards. In the pack every card lies upright, as it would in a real one; a landscape card turns
  // round once it's on top of the stack. Stickers have no upright: they stay as they are. Measured up front, while the pack is still sealed: measuring as each card
  // joins the stack showed it turning upright behind the top card.
  const [landscape, setLandscape] = useState(() => new Set())
  useEffect(() => {
    // One photo at a time, so a big pack never holds all its full-size decodes at once.
    ;(async () => {
      const wide = new Set()
      for (const card of cards.filter((other) => other.kind !== 'sticker')) {
        const bitmap = await createImageBitmap(card.front)
        if (bitmap.width > bitmap.height) wide.add(card.id)
        bitmap.close?.()
      }
      setLandscape(wide)
    })().catch(() => {})
  }, [])
  // The stack's current tilt in degrees, and whether a finger is on it (no easing while it follows the finger).
  const [tilt, setTilt] = useState(REST_TILT)
  const [dragging, setDragging] = useState(false)
  // 'left' or 'right' while the top card flies off that way.
  const [flick, setFlick] = useState(null)

  const packRef = useRef()
  function tearMove(event) {
    if (!startRef.current) return
    const width = packRef.current.getBoundingClientRect().width
    const dx = event.clientX - startRef.current.x
    const progress = Math.min(1, Math.abs(dx) / (width * TEAR_DISTANCE))
    if (dx) setTearLeft(dx < 0)
    setTear(progress)
    if (progress === 1) open()
  }
  function open() {
    startRef.current = null
    setStage('torn')
    setTimeout(() => setStage('revealing'), TEAR_MS)
  }

  function next(direction) {
    if (flick) return
    setFlick(direction)
    setTimeout(() => {
      setFlick(null)
      if (index + 1 < ordered.length) setIndex(index + 1)
      else setStage('summary')
    }, FLICK_MS)
  }
  const clampTilt = (value) => Math.max(-MAX_TILT, Math.min(MAX_TILT, value))
  function stackMove(event) {
    if (!startRef.current) return
    setTilt({
      x: clampTilt((startRef.current.y - event.clientY) * TILT_PER_PIXEL),
      y: clampTilt((event.clientX - startRef.current.x) * TILT_PER_PIXEL),
    })
  }
  function stackUp(event) {
    if (!startRef.current) return
    const dx = event.clientX - startRef.current.x
    const dy = event.clientY - startRef.current.y
    startRef.current = null
    setDragging(false)
    setTilt(REST_TILT)
    if (Math.abs(dx) >= FLICK_DISTANCE) next(dx < 0 ? 'left' : 'right')
    else if (Math.hypot(dx, dy) < TAP_DISTANCE) next('right')
  }

  // The summary's column count that gives the biggest square cells while all of them still fit on screen.
  const gridRef = useRef()
  const [layout, setLayout] = useState({ columns: 3, cell: 100 })
  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const fit = () => {
      const { width, height } = grid.getBoundingClientRect()
      let best = { columns: 1, cell: 0 }
      for (let count = 1; count <= ordered.length; count++) {
        const rows = Math.ceil(ordered.length / count)
        const cell = Math.min((width - GRID_GAP * (count - 1)) / count, (height - GRID_GAP * (rows - 1)) / rows)
        if (cell > best.cell) best = { columns: count, cell }
      }
      setLayout({ columns: best.columns, cell: Math.floor(best.cell) })
    }
    const observer = new ResizeObserver(fit)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [stage])

  const [reduceMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  // Stickers come last and don't flip, so the last card to flip is the last one with a back.
  const flipBackAt = FLIP_START_MS + ordered.findLastIndex((card) => card.back) * FLIP_STAGGER_MS + FLIP_MS + FLIP_PAUSE_MS
  const finish = () => { dialogRef.current.close(); onDone() }
  const reveal = stage === 'revealing' || stage === 'torn'

  return (
    <dialog ref={dialogRef} class="pack-opening" onCancel={(e) => { e.preventDefault(); finish() }}>
      {stage !== 'summary' && <button type="button" class="pack-skip" onClick={() => setStage('summary')}>{t('Skip')}</button>}
      {stage !== 'summary' && (
        <div
          class={`pack-stage ${stage}`}
          onPointerDown={stage === 'sealed' ? (e) => { setTouched(true); startRef.current = { x: e.clientX }; e.currentTarget.setPointerCapture(e.pointerId) } : undefined}
          onPointerMove={stage === 'sealed' ? tearMove : undefined}
          onPointerUp={() => { if (stage === 'sealed') { startRef.current = null; setTear(0) } }}
          onPointerCancel={() => { startRef.current = null; setTear(0) }}
        >
          {stage === 'sealed' && <h2 class="pack-joke">{t('A card pack for you!! 😆')}</h2>}
          {reveal && (
            <div
              class={`pack-cards${dragging ? ' dragging' : ''}`}
              style={{ '--tilt-x': `${tilt.x}deg`, '--tilt-y': `${tilt.y}deg` }}
              onPointerDown={stage === 'revealing' ? (e) => { startRef.current = { x: e.clientX, y: e.clientY }; setDragging(true); e.currentTarget.setPointerCapture(e.pointerId) } : undefined}
              onPointerMove={stage === 'revealing' ? stackMove : undefined}
              onPointerUp={stage === 'revealing' ? stackUp : undefined}
              onPointerCancel={() => { startRef.current = null; setDragging(false); setTilt(REST_TILT) }}
            >
              {/* The cards still to come, a few px apart in depth, so the stack's edge shows when it's tilted. */}
              {ordered.slice(index, index + STACK_SHOWN).reverse().map((card, place, shown) => {
                const depth = shown.length - 1 - place
                // The next card turns round as the top one flies off, not once it's gone.
                const onTop = stage === 'revealing' && (depth === 0 || (depth === 1 && flick))
                return (
                  <div
                    key={card.id}
                    class={`pack-card${card.kind === 'sticker' ? ' sticker' : ''}${landscape.has(card.id) && !onTop ? ' upright' : ''}${depth === 0 && flick ? ` gone-${flick}` : ''}`}
                    style={{ '--depth': depth, '--size': scaleOf(card) }}
                  >
                    <CardImage blob={card.front} style={cardCornerStyle(card)} />
                  </div>
                )
              })}
            </div>
          )}
          <div
            ref={packRef}
            class={`pack${stage === 'sealed' ? '' : ' torn'}${tearLeft ? ' tear-left' : ''}`}
            style={{ '--tear': tear }}
          >
            {stage === 'sealed' && !touched && <div class="pack-finger" />}
            <div class="pack-top" />
            <div class="pack-body">
              <Logo />
              <strong>{name}</strong>
              <span>{t('{count} cards and stickers', { count: cards.length })}</span>
            </div>
          </div>
          <p class="pack-hint">
            {stage === 'sealed' ? t('Swipe sideways to open')
              // Only on the first card: by the second, flicking is known.
              : stage === 'revealing' && index === 0 ? t('Tap or swipe for the next')
              : ' '}
          </p>
        </div>
      )}
      {stage === 'summary' && (
        <div class="pack-summary">
          <h2>{t('You got {count} cards and stickers!', { count: cards.length })}</h2>
          <div class="pack-grid" ref={gridRef} style={{ '--columns': layout.columns, '--cell': `${layout.cell}px` }}>
            {ordered.map((card, place) => (
              // Drag to tilt and tap to flip, as on a card's own page.
              <div key={card.id} class="pack-grid-item" style={{ '--place': place }}>
                {card.kind === 'sticker'
                  ? <Card3D front={card.front} sticker size={scaleOf(card)} maxHeight={layout.cell} />
                  : <Card3D front={card.front} back={card.back} frontEdit={card.frontEdit} backEdit={card.backEdit} maxHeight={layout.cell} flipDelays={reduceMotion ? [] : [FLIP_START_MS + place * FLIP_STAGGER_MS, flipBackAt + place * FLIP_STAGGER_MS]} />}
              </div>
            ))}
          </div>
          <button type="button" class="primary pack-done" onClick={finish}>{t('Start')}</button>
        </div>
      )}
    </dialog>
  )
}
