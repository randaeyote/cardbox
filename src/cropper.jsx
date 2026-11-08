import { useEffect, useRef, useState } from 'preact/hooks'
import { shareFile, extensionOf } from './backup.js'
import { useObjectUrl } from './ui.jsx'
import { t } from './i18n.js'
import { loadOpenCv, detectCorners, warpCard, adjustCard, measureCorners, canvasToWebp, DEFAULT_ADJUSTMENT, orderCorners, outputSize, defaultStickerArea, cutStickerCanvas } from './crop.js'

const MAGNIFIER_SIZE = 110
const MAGNIFIER_ZOOM = 2.5
const MAGNIFIER_MARGIN = 12
const FINGER_CLEARANCE = 60
const INSET_FRACTION = 0.08
// Long side, so it applies equally to landscape and portrait cards.
const MIN_SHARP_DIMENSION = 1200

const insetCorners = ({ width, height }) => {
  const x = width * INSET_FRACTION
  const y = height * INSET_FRACTION
  return [{ x, y }, { x: width - x, y }, { x: width - x, y: height - y }, { x, y: height - y }]
}

const PREVIEW_DELAY_MS = 120

const icon = (children, size = 22) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{children}</svg>
)
const CHECK = icon(<path d="m5 12.5 4.5 4.5L19 7.5" />, 24)
const SHARE = icon(<><path d="M12 3v12" /><path d="m7.5 7.5 4.5-4.5 4.5 4.5" /><path d="M8 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-2" /></>)
const BACK = icon(<path d="m15 5-7 7 7 7" />)
const BRUSH = icon(<><path d="M18.5 3.5a2.1 2.1 0 0 1 3 3L11 17l-4-4Z" /><path d="M7 13c-2 0-3.5 1.5-3.5 3.5 0 1.5-.5 2.5-1.5 3.5 3 1 7 0 8.5-1.5L7 13Z" /></>)
const UNDO = icon(<><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>)
// On screen, so it's a finger's width however far the photo is zoomed out.
const BRUSH_RADIUS_PX = 14

// For corners in top-left, top-right, bottom-right, bottom-left order: the corner sharing each one's x, and its y.
const SAME_X = [3, 2, 1, 0]
const SAME_Y = [1, 0, 3, 2]
const areaCorners = ({ x, y, width, height }) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }]
function cornersArea(corners) {
  const xs = corners.map((corner) => corner.x)
  const ys = corners.map((corner) => corner.y)
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}

// edit: the settings a saved image was rendered with ({ corners or area, rotation, enhance }), so re-editing starts
// there. onDone receives { image, edit }.
// sticker: the corners mark the area the sticker is in rather than a card's corners, and Cut out cuts it out along its
// edge (a PNG) before the same rotate/enhance step; Crop as rectangle is still there as a fallback.
export function CornerEditor({ original: blob, edit, onDone, onCancel, sticker = false }) {
  const url = useObjectUrl(blob)
  const [source, setSource] = useState(null)
  const [scale, setScale] = useState(0)
  const [detected, setDetected] = useState(null)
  const [corners, setCorners] = useState(null)
  const [openCvError, setOpenCvError] = useState(null)
  const [dragging, setDragging] = useState(null)
  const [cutting, setCutting] = useState(false)
  // How ✓ finishes: stickers 'cut' or 'rectangle', cards 'crop' or 'whole'. Re-editing starts on what was used before.
  const [finishMode, setFinishMode] = useState(() => (sticker ? (edit?.corners ? 'rectangle' : 'cut') : edit && edit.corners === null ? 'whole' : 'crop'))
  // Cut out mode: the cut-out for the current area, worked out once the handles settle, so ✓ shows no surprises.
  // { key: the area it's for, cut: cutStickerCanvas's result or null }.
  const [cutPreview, setCutPreview] = useState(null)
  // Cut out mode: brush strokes over what should be background (a shadow, a bit of table), in the original's pixels.
  const [removed, setRemoved] = useState(() => edit?.removed ?? [])
  const [brushing, setBrushing] = useState(false)
  const [stroke, setStroke] = useState(null)
  const painting = brushing && finishMode === 'cut'
  const cutKey = () => JSON.stringify({ area: cornersArea(corners), removed })
  useEffect(() => {
    if (finishMode !== 'cut' || !corners || dragging !== null || !openCvRef.current) return
    const key = cutKey()
    if (cutPreview?.key === key) return
    let cancelled = false
    // Delayed so a quick run of drags doesn't queue a cut-out (a fraction of a second each) per drag.
    const timer = setTimeout(() => {
      cutStickerCanvas(openCvRef.current, blob, cornersArea(corners), removed, { preview: true }).then((cut) => !cancelled && setCutPreview({ key, cut }), () => !cancelled && setCutPreview({ key, cut: null }))
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [finishMode, corners, dragging, removed])
  const modes = sticker ? [['cut', t('Cut out')], ['rectangle', t('Rectangle')]] : [['crop', t('Crop')], ['whole', t('Whole photo')]]
  const imageRef = useRef()
  const stageRef = useRef()
  const openCvRef = useRef()

  useEffect(() => {
    if (!url) return
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
      setSource(canvas)
    }
    image.src = url
  }, [url])

  useEffect(() => {
    if (!source) return
    let cancelled = false
    loadOpenCv().then((cv) => {
      if (cancelled) return
      openCvRef.current = cv
      if (sticker) {
        const start = areaCorners(defaultStickerArea(source))
        setDetected(start)
        setCorners(edit?.area ? areaCorners(edit.area) : start)
        return
      }
      let found = null
      try {
        found = detectCorners(cv, source)
      } catch (error) {
        console.error('Edge detection failed', error)
      }
      const start = found ?? insetCorners(source)
      setDetected(start)
      setCorners(edit?.corners ?? start)
    }, (error) => {
      console.error('OpenCV failed to load', error)
      if (!cancelled) setOpenCvError(error?.message || String(error))
    })
    return () => { cancelled = true }
  }, [source])

  // Fit the photo to the stage by whichever of width or height is tighter, and size the image and overlay from that
  // same scale. Measuring the <img> box instead breaks on wide screens, where the box is letterboxed.
  const updateScale = () => {
    const stage = stageRef.current
    if (!stage || !source) return
    const { width: stageWidth, height: stageHeight } = stage.getBoundingClientRect()
    // Detached while the adjust step is showing.
    if (!stageWidth) return
    setScale(Math.min(stageWidth / source.width, stageHeight / source.height))
  }
  useEffect(() => {
    updateScale()
    window.addEventListener('resize', updateScale)
    return () => window.removeEventListener('resize', updateScale)
  }, [source])

  function drag(event, index) {
    const rect = imageRef.current.getBoundingClientRect()
    const x = Math.min(source.width, Math.max(0, (event.clientX - rect.left) / scale))
    const y = Math.min(source.height, Math.max(0, (event.clientY - rect.top) / scale))
    // A sticker's area stays a rectangle: the corners beside the dragged one follow it.
    setCorners(corners.map((corner, i) => (i === index ? { x, y }
      : sticker && i === SAME_X[index] ? { ...corner, x }
      : sticker && i === SAME_Y[index] ? { ...corner, y }
      : corner)))
  }

  // Adjust step: the warped crop (or sticker cut-out) is rendered once, then rotation/enhance re-render a preview from it.
  const [warped, setWarped] = useState(null)
  const [useCorners, setUseCorners] = useState(true)
  // The area a sticker was cut out of, while the adjust step shows that cut-out; null for a straight crop.
  const [cutArea, setCutArea] = useState(null)
  // Stickers saved before they had rotate/enhance only stored their area.
  const [adjustment, setAdjustment] = useState(() => (edit?.rotation === undefined ? DEFAULT_ADJUSTMENT : { rotation: edit.rotation, enhance: Number(edit.enhance) || 0 }))
  const [preview, setPreview] = useState(null)
  const previewUrl = useObjectUrl(preview)
  const render = (canvas = adjustCard(warped, adjustment)) => canvasToWebp(canvas, { transparent: !!cutArea })

  function toAdjust(withCorners) {
    try {
      setCutArea(null)
      setUseCorners(withCorners)
      setWarped(warpCard(openCvRef.current, source, withCorners ? orderCorners(corners) : null))
    } catch (error) {
      alert(t('Could not crop image: {message}', { message: error.message }))
    }
  }

  // Delayed so dragging the slider doesn't re-render a 2400px image on every step.
  useEffect(() => {
    if (!warped) return setPreview(null)
    let cancelled = false
    const timer = setTimeout(() => {
      render().then((image) => !cancelled && setPreview(image))
    }, preview ? PREVIEW_DELAY_MS : 0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [warped, adjustment])

  const rotate = (degrees) => setAdjustment({ ...adjustment, rotation: (adjustment.rotation + degrees + 360) % 360 })
  // Rendered afresh rather than reusing the preview, which may lag the slider's last position.
  const finish = async () => {
    const canvas = adjustCard(warped, adjustment)
    const straight = !cutArea && useCorners
    onDone({
      image: await render(canvas),
      edit: {
        ...(cutArea ? { area: cutArea, ...(removed.length && { removed }) } : { corners: useCorners ? orderCorners(corners) : null }),
        ...adjustment,
        ...(!cutArea && { radius: straight ? measureCorners(canvas) : null }),
      },
    })
  }

  if (warped) {
    return (
      <div class="cropper editor">
        <div class="editor-top">
          <button type="button" class="icon-button" aria-label={t('Back to crop')} onClick={() => setWarped(null)}>{BACK}</button>
          <button type="button" class="icon-button editor-done" aria-label={t('Done')} disabled={!preview} onClick={finish}>{CHECK}</button>
        </div>
        <div class="cropper-stage">{previewUrl && <img class="cropper-preview" src={previewUrl} alt="" />}</div>
        <div class="editor-bottom">
          <button type="button" class="icon-button" onClick={() => rotate(-90)} aria-label={t('Rotate left')}>↺</button>
          <label class="slider">
            <span>{t('Enhance')}</span>
            <input
              type="range" min="0" max="100" step="5"
              value={Math.round(adjustment.enhance * 100)}
              onInput={(e) => setAdjustment({ ...adjustment, enhance: e.target.value / 100 })}
            />
            <output>{Math.round(adjustment.enhance * 100)}%</output>
          </label>
          <button type="button" class="icon-button" onClick={() => rotate(90)} aria-label={t('Rotate right')}>↻</button>
        </div>
      </div>
    )
  }

  const cardSize = corners && outputSize(orderCorners(corners))
  const cardTooSmall = !sticker && cardSize && Math.max(cardSize.width, cardSize.height) < MIN_SHARP_DIMENSION
  async function cutOut() {
    setCutting(true)
    try {
      const area = cornersArea(corners)
      // The preview's fewer GrabCut rounds came out the same as the full five on test photos, so it's kept rather than redone.
      const cut = cutPreview?.key === cutKey() ? cutPreview.cut : await cutStickerCanvas(openCvRef.current, blob, area, removed)
      if (!cut) return alert(t('No outline found. Try a tighter area, or crop as a rectangle.'))
      setCutArea(area)
      setWarped(cut.canvas)
    } catch (error) {
      alert(t('Could not cut out: {message}', { message: error.message }))
    } finally {
      setCutting(false)
    }
  }
  const settledPreview = finishMode === 'cut' && dragging === null && corners && cutPreview?.key === cutKey() ? cutPreview : null
  const brushPoint = (event) => {
    const rect = imageRef.current.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale }
  }
  const strokePath = ({ points }) => points.map(({ x, y }, i) => `${i ? 'L' : 'M'}${x * scale} ${y * scale}`).join('')
  const shownCut = settledPreview?.cut
  const ready = finishMode === 'whole' ? !!source : !!corners && !cutting
  const apply = () => (finishMode === 'cut' ? cutOut() : toAdjust(finishMode !== 'whole'))
  const width = source ? source.width * scale : 0
  const height = source ? source.height * scale : 0
  const screen = corners && corners.map(({ x, y }) => ({ x: x * scale, y: y * scale }))
  const active = dragging !== null && screen ? screen[dragging] : null
  // Pinned bottom-left; moves to bottom-right while the finger is over that spot.
  const magnifierTop = height - MAGNIFIER_SIZE - MAGNIFIER_MARGIN
  const fingerOverBottomLeft = active && active.x < MAGNIFIER_SIZE + FINGER_CLEARANCE && active.y > magnifierTop - FINGER_CLEARANCE
  const magnifierLeft = fingerOverBottomLeft ? width - MAGNIFIER_SIZE - MAGNIFIER_MARGIN : MAGNIFIER_MARGIN

  return (
    <div class="cropper editor">
      <div class="editor-top">
        <button type="button" class="icon-button" aria-label={t('Cancel')} onClick={onCancel}>✕</button>
        <button type="button" class="editor-reset" disabled={!detected || finishMode === 'whole'} onClick={() => { setCorners(detected); setRemoved([]) }}>{t('Reset')}</button>
        <div class="editor-top-end">
          <button
            type="button" class="icon-button" aria-label={t('Save original')}
            onClick={() => shareFile(new File([blob], `cardbox-original-${Date.now()}.${extensionOf(blob)}`, { type: blob.type }))}
          >{SHARE}</button>
          <button type="button" class="icon-button editor-done" aria-label={t('Done')} disabled={!ready} onClick={apply}>{CHECK}</button>
        </div>
      </div>
      <div class="cropper-stage" ref={stageRef}>
        <div class="cropper-frame">
          {url && scale > 0 && <img ref={imageRef} src={url} alt="" draggable={false} style={{ width: `${width}px`, height: `${height}px` }} />}
          {shownCut && (
            <>
              <div class="cropper-cut-backdrop" />
              <canvas
                class="cropper-cut"
                ref={(element) => {
                  if (!element) return
                  element.width = shownCut.canvas.width
                  element.height = shownCut.canvas.height
                  element.getContext('2d').drawImage(shownCut.canvas, 0, 0)
                }}
                style={{ left: `${shownCut.box.x * scale}px`, top: `${shownCut.box.y * scale}px`, width: `${shownCut.box.width * scale}px`, height: `${shownCut.box.height * scale}px` }}
              />
            </>
          )}
          {screen && finishMode !== 'whole' && (
            <svg width={width} height={height}>
              {!shownCut && <path
                class="cropper-dim"
                fill-rule="evenodd"
                d={`M0 0H${width}V${height}H0Z M${screen.map(({ x, y }) => `${x} ${y}`).join('L')}Z`}
              />}
              <polygon class="cropper-outline" points={screen.map(({ x, y }) => `${x},${y}`).join(' ')} />
              {painting && (
                <>
                  {[...removed, ...(stroke ? [stroke] : [])].map((each, index) => (
                    <path key={index} class="cropper-stroke" d={strokePath(each)} stroke-width={each.radius * 2 * scale} />
                  ))}
                  <rect
                    width={width} height={height} fill="transparent"
                    onPointerDown={(e) => {
                      setStroke({ radius: BRUSH_RADIUS_PX / scale, points: [brushPoint(e)] })
                      try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
                    }}
                    onPointerMove={(e) => stroke && setStroke({ ...stroke, points: [...stroke.points, brushPoint(e)] })}
                    onPointerUp={() => { if (stroke) setRemoved([...removed, stroke]); setStroke(null) }}
                    onPointerCancel={() => setStroke(null)}
                  />
                </>
              )}
              {!painting && screen.map(({ x, y }, index) => (
                <g key={index}>
                  <circle class="cropper-handle" cx={x} cy={y} r="11" />
                  <circle
                    cx={x} cy={y} r="24" fill="transparent"
                    onPointerDown={(e) => {
                      setDragging(index)
                      drag(e, index)
                      try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
                    }}
                    onPointerMove={(e) => dragging === index && drag(e, index)}
                    onPointerUp={() => setDragging(null)}
                    onPointerCancel={() => setDragging(null)}
                  />
                </g>
              ))}
            </svg>
          )}
          {active && (
            <div
              class="cropper-magnifier"
              style={{
                left: `${magnifierLeft}px`, top: `${magnifierTop}px`, width: `${MAGNIFIER_SIZE}px`, height: `${MAGNIFIER_SIZE}px`,
                backgroundImage: `url(${url})`,
                backgroundSize: `${width * MAGNIFIER_ZOOM}px ${height * MAGNIFIER_ZOOM}px`,
                backgroundPosition: `${MAGNIFIER_SIZE / 2 - active.x * MAGNIFIER_ZOOM}px ${MAGNIFIER_SIZE / 2 - active.y * MAGNIFIER_ZOOM}px`,
              }}
            />
          )}
          {!corners && !openCvError && <div class="cropper-message">{t('Detecting edges…')}</div>}
          {cutting && <div class="cropper-message">{t('Cutting out…')}</div>}
        </div>
      </div>
      {openCvError && <p class="cropper-error">{t('Edge detection could not be loaded: {message}. You can still use the original photo.', { message: openCvError })}</p>}
      {settledPreview && !shownCut && <p class="cropper-error">{t('No outline found. Try a tighter area, or crop as a rectangle.')}</p>}
      {cardTooSmall && (
        <div class="cropper-warning">
          <span>{t('The card is small in this photo, so text may be blurry. Retake closer for a sharper image.')}</span>
        </div>
      )}
      {finishMode === 'cut' && (
        <div class="editor-brush">
          <button type="button" class="icon-button" aria-pressed={brushing} onClick={() => setBrushing(!brushing)}>{BRUSH}<span>{t('Brush away')}</span></button>
          {removed.length > 0 && <button type="button" class="icon-button" aria-label={t('Undo')} onClick={() => setRemoved(removed.slice(0, -1))}>{UNDO}</button>}
        </div>
      )}
      {painting && <p class="editor-hint">{t('Paint over shadows or background to leave them out.')}</p>}
      <div class="rapid-modes" role="radiogroup" aria-label={t('Finish as')}>
        {modes.map(([value, label]) => (
          <button type="button" key={value} role="radio" aria-checked={finishMode === value} onClick={() => setFinishMode(value)}>{label}</button>
        ))}
      </div>
    </div>
  )
}
