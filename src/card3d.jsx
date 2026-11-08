import { useEffect, useRef, useState } from 'preact/hooks'
import { cornerStyle, useObjectUrl } from './ui.jsx'
import { t } from './i18n.js'

const DEGREES_PER_PIXEL = 0.5
// Without a back photo the card only rocks, so the blank backface never shows.
const MAX_ANGLE_WITHOUT_BACK = 35
const TAP_THRESHOLD = 6
const SNAP_DURATION_MS = 450
// How far a flick carries: release speed × this many ms of coasting before snapping to the nearest face.
const MOMENTUM_MS = 250
const VELOCITY_WINDOW_MS = 80
const MAX_SNAP_DURATION_MS = 1400
const MAX_HEIGHT_FRACTION = 0.6
const FLIP_MS = 800

const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value))
const halfTurns = (degrees) => Math.round(degrees / 180)
// Angle of the face towards the viewer on one axis, from -90 to 90.
const faceAngle = (degrees) => ((((degrees + 90) % 180) + 180) % 180) - 90
const radians = (degrees) => (degrees * Math.PI) / 180
const mix = (from, to, amount) => from + (to - from) * amount

// Degrees per ms over the last few move events; zero if the finger paused before lifting.
function releaseVelocity(samples) {
  const first = samples[0]
  const last = samples.at(-1)
  const elapsed = last && last.time - first.time
  if (!elapsed || performance.now() - last.time > VELOCITY_WINDOW_MS) return { x: 0, y: 0 }
  return { x: (last.x - first.x) / elapsed, y: (last.y - first.y) / elapsed }
}

function fitInside(image, boxWidth, boxHeight) {
  const scale = Math.min(boxWidth / image.width, boxHeight / image.height)
  return { width: image.width * scale, height: image.height * scale }
}

// sticker: a cut-out with no back, drawn by its own outline at `size` × the width a card would get; the stage keeps
// the height for `layoutSize`, so dragging the size slider doesn't move the page under the finger.
// frontEdit, backEdit: each side's edit, for its measured corners. maxHeight (px): the tallest the card may be.
// flipDelays (ms): a card with a back flips over (a half turn, same way each time) at each of these times after mounting.
export function Card3D({ front, back, frontEdit, backEdit, onSideChange, sticker = false, size = 1, layoutSize = size, maxHeight = window.innerHeight * MAX_HEIGHT_FRACTION, flipDelays = [] }) {
  const frontUrl = useObjectUrl(front)
  const backUrl = useObjectUrl(back)
  // x: vertical drag (rotateX), y: horizontal drag (rotateY), both in degrees.
  const [rotation, setRotation] = useState({ x: 0, y: 0 })
  const [natural, setNatural] = useState({})
  const [stageWidth, setStageWidth] = useState(0)
  const stageRef = useRef()
  const dragRef = useRef(null)
  // Latest onPointerEnd, for the window listeners added at the start of a drag.
  const endRef = useRef()
  // Mirrors `rotation` so pointer handlers and the animation always read the latest angle, even between renders.
  const rotationRef = useRef(rotation)
  const frameRef = useRef(0)

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width))
    observer.observe(stageRef.current)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frameRef.current)
      dragRef.current?.stopListening()
    }
  }, [])

  const show = (next) => {
    rotationRef.current = next
    setRotation(next)
  }

  // Animated in JS rather than with a CSS transition because the card's size is derived from the live angle.
  // speed (degrees/ms) makes the ease-out start at the finger's release speed, so a flick glides instead of jerking.
  function animateTo(target, speed = 0, flip = false) {
    cancelAnimationFrame(frameRef.current)
    const from = rotationRef.current
    const distance = Math.max(Math.abs(target.x - from.x), Math.abs(target.y - from.y))
    // An ease-out cubic starts at 3 × distance / duration, so pick the duration that matches the release speed.
    const duration = flip ? FLIP_MS : speed > 0 ? Math.min(MAX_SNAP_DURATION_MS, Math.max(SNAP_DURATION_MS, (3 * distance) / speed)) : SNAP_DURATION_MS
    const startTime = performance.now()
    const step = (now) => {
      const progress = Math.min(1, (now - startTime) / duration)
      const eased = flip ? (1 - Math.cos(Math.PI * progress)) / 2 : 1 - (1 - progress) ** 3
      show({ x: mix(from.x, target.x, eased), y: mix(from.y, target.y, eased) })
      if (progress < 1) frameRef.current = requestAnimationFrame(step)
    }
    frameRef.current = requestAnimationFrame(step)
  }

  // Through animateTo, not a CSS spin, so a back in the other orientation twists round as it does on a tap.
  useEffect(() => {
    if (!back) return
    const timers = flipDelays.map((delay) => setTimeout(() => animateTo({ x: 0, y: halfTurns(rotationRef.current.y) * 180 + 180 }, 0, true), delay))
    return () => timers.forEach(clearTimeout)
  }, [])

  const snap = (degrees) => (back ? halfTurns(degrees) * 180 : 0)
  const showingBack = !!back && (halfTurns(rotation.x) + halfTurns(rotation.y)) % 2 !== 0
  useEffect(() => { onSideChange?.(showingBack ? 'back' : 'front') }, [showingBack])

  function onPointerDown(event) {
    cancelAnimationFrame(frameRef.current)
    const start = rotationRef.current
    // Once flipped upside down (x at 180°), rotateY turns the opposite way on screen, so mirror horizontal drags.
    const direction = halfTurns(start.x) % 2 === 0 ? 1 : -1
    // Releasing the mouse outside the browser window may never reach the card, even with pointer capture, so the
    // window also listens: a release, focus loss, or the mouse coming back with no button held ends the drag.
    const endOutside = (windowEvent) => {
      if (windowEvent.type === 'pointermove' && windowEvent.buttons !== 0) return
      endRef.current()
    }
    const outsideEvents = ['pointerup', 'pointercancel', 'pointermove', 'blur']
    outsideEvents.forEach((type) => window.addEventListener(type, endOutside))
    const stopListening = () => outsideEvents.forEach((type) => window.removeEventListener(type, endOutside))
    dragRef.current = { x: event.clientX, y: event.clientY, start, direction, moved: false, samples: [], stopListening }
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
  }

  function onPointerMove(event) {
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (Math.hypot(dx, dy) > TAP_THRESHOLD) drag.moved = true
    const limit = back ? Infinity : MAX_ANGLE_WITHOUT_BACK
    const next = {
      x: clamp(drag.start.x - dy * DEGREES_PER_PIXEL, limit),
      y: clamp(drag.start.y + dx * DEGREES_PER_PIXEL * drag.direction, limit),
    }
    const now = performance.now()
    drag.samples = [...drag.samples.filter((sample) => now - sample.time < VELOCITY_WINDOW_MS), { time: now, ...next }]
    show(next)
  }

  function onPointerEnd() {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    drag.stopListening()
    if (!drag.moved) return animateTo({ x: snap(drag.start.x), y: snap(drag.start.y) + (back ? 180 : 0) })
    const current = rotationRef.current
    const velocity = releaseVelocity(drag.samples)
    const target = { x: snap(current.x + velocity.x * MOMENTUM_MS), y: snap(current.y + velocity.y * MOMENTUM_MS) }
    animateTo(target, Math.hypot(velocity.x, velocity.y))
  }

  endRef.current = onPointerEnd

  // Each side keeps its own shape on screen. facing is the z of the card's normal: 1 = front towards you, -1 = back,
  // 0 = edge-on. A back in the other orientation (portrait front, landscape back) is the same card printed sideways:
  // it's drawn turned on the card, and the card twists a quarter turn as it flips, so neither side is stretched.
  const fitFront = (scale) => natural.front && fitInside(natural.front, stageWidth * scale, Math.min(maxHeight, sticker ? stageWidth * scale : Infinity))
  const frontSize = fitFront(sticker ? size : 1)
  const backSize = (natural.back && back && fitInside(natural.back, stageWidth, maxHeight)) || frontSize
  const portrait = (side) => side.height > side.width
  const turned = !!(back && natural.back && frontSize && portrait(natural.front) !== portrait(natural.back))
  const stageHeight = sticker ? fitFront(layoutSize)?.height : frontSize && Math.max(frontSize.height, backSize.height)
  const facing = Math.cos(radians(rotation.x)) * Math.cos(radians(rotation.y))
  const backAmount = (1 - facing) / 2
  const backBox = turned ? { width: backSize.height, height: backSize.width } : backSize
  const cardSize = frontSize && {
    width: mix(frontSize.width, backBox.width, backAmount),
    height: mix(frontSize.height, backBox.height, backAmount),
  }

  const faceX = faceAngle(rotation.x)
  const faceY = faceAngle(rotation.y)
  const glare = {
    background: `radial-gradient(circle at ${50 - faceY * 1.5}% ${50 + faceX * 1.5}%, rgb(255 255 255 / 0.55), transparent 60%)`,
    opacity: Math.min(1, (Math.abs(faceX) + Math.abs(faceY)) / 40),
    // On a sticker the glare only lights the sticker itself, not the transparent box around it.
    ...(sticker && { maskImage: `url(${frontUrl})`, WebkitMaskImage: `url(${frontUrl})`, maskSize: '100% 100%', WebkitMaskSize: '100% 100%' }),
  }
  const remember = (side) => (event) =>
    setNatural((current) => ({ ...current, [side]: { width: event.target.naturalWidth, height: event.target.naturalHeight } }))

  return (
    <div class="card3d-wrapper">
      <div
        class="card3d-stage"
        ref={stageRef}
        style={{ height: stageHeight ? `${stageHeight}px` : undefined }}
      >
        <div
          class={sticker ? 'card3d sticker' : 'card3d'}
          style={{
            width: cardSize ? `${cardSize.width}px` : '100%',
            height: cardSize ? `${cardSize.height}px` : '0px',
            transform: `rotateZ(${turned ? backAmount * 90 : 0}deg) rotateX(${rotation.x}deg) rotateY(${rotation.y}deg)`,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onLostPointerCapture={onPointerEnd}
          onDragStart={(event) => event.preventDefault()}
        >
          {frontUrl && (
            <div class="card3d-face" style={cornerStyle(frontEdit)}>
              <img src={frontUrl} alt={t('Front side')} draggable={false} onLoad={remember('front')} />
              <div class="card3d-glare" style={glare} />
            </div>
          )}
          {backUrl && (
            <div class="card3d-face card3d-back" style={cornerStyle(backEdit, turned)}>
              <img
                src={backUrl} alt={t('Back side')} draggable={false} onLoad={remember('back')}
                class={turned ? 'turned' : undefined}
                style={turned && { width: `${cardSize.height}px`, height: `${cardSize.width}px` }}
              />
              <div class="card3d-glare" style={glare} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
