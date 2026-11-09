import { render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { renderSVG } from 'uqr'
import { t, language, setLanguage, LANGUAGES } from './i18n.js'

const ARM_CONFIRM_MS = 4000

export function useObjectUrl(blob) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    if (!blob) return setUrl(null)
    const objectUrl = URL.createObjectURL(blob)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [blob])
  return url
}

// A preference kept in localStorage: parse turns the stored string (null when unset) into the value; set stores
// String(value).
export function useStoredState(key, parse = (stored) => stored) {
  const [value, setValue] = useState(() => parse(localStorage.getItem(key)))
  return [value, (next) => { localStorage.setItem(key, String(next)); setValue(next) }]
}

// For a <dialog> that is open for as long as it's mounted: spread the result on it. Esc and a tap on the backdrop
// leave through onClose, which removes the dialog, instead of the browser closing it behind the app's back.
export function useModal(onClose) {
  const ref = useRef()
  useEffect(() => { ref.current.showModal() }, [])
  return { ref, onCancel: (e) => { e.preventDefault(); onClose() }, onClick: (e) => e.target === ref.current && onClose() }
}

// In place of confirm() and alert(): an alert in the app's own style. Resolves true for the confirm button, false for
// Cancel or Esc. cancel null: a notice with only the confirm button. danger: the confirm button throws something away.
export function ask(message, { confirm = t('OK'), cancel = t('Cancel'), danger = false } = {}) {
  return new Promise((resolve) => {
    const host = document.body.appendChild(document.createElement('div'))
    const answer = (value) => { render(null, host); host.remove(); resolve(value) }
    render(<AskDialog message={message} confirm={confirm} cancel={cancel} danger={danger} onAnswer={answer} />, host)
  })
}
export const notify = (message) => ask(message, { cancel: null })

function AskDialog({ message, confirm, cancel, danger, onAnswer }) {
  const ref = useRef()
  useEffect(() => { ref.current.showModal() }, [])
  return (
    <dialog ref={ref} class="alert" onCancel={(e) => { e.preventDefault(); onAnswer(false) }}>
      <h2>{message}</h2>
      <div class="alert-buttons">
        {cancel && <button type="button" onClick={() => onAnswer(false)}>{cancel}</button>}
        <button type="button" class={danger ? 'danger' : 'primary'} onClick={() => onAnswer(true)}>{confirm}</button>
      </div>
    </dialog>
  )
}

// A copy of the set with id removed, or added if it wasn't there.
export function toggled(set, id) {
  const next = new Set(set)
  if (!next.delete(id)) next.add(id)
  return next
}

// A card side's own corners (its edit's measured radius) as a style, or nothing to keep the stylesheet's default.
// sideways: shown turned a quarter, so its width and height swap.
export const cornerStyle = (edit, sideways = false) => {
  const radius = edit?.radius
  if (!radius) return undefined
  const [x, y] = sideways ? [radius.y, radius.x] : [radius.x, radius.y]
  return { borderRadius: `${x * 100}% / ${y * 100}%` }
}

// A card's front or back corners, but a sticker has none: it's drawn by its outline.
export const cardCornerStyle = (card, side = 'front') => (card.kind === 'sticker' ? undefined : cornerStyle(card[`${side}Edit`]))

// lazy: for long lists, decoded only as it nears the screen.
export function CardImage({ blob, className, style, onLoad, lazy = false }) {
  const url = useObjectUrl(blob)
  // Not draggable: the browser's own image drag would fight the list's reordering and fanning.
  return url ? <img class={className} style={style} src={url} alt="" draggable={false} onLoad={onLoad} loading={lazy ? 'lazy' : undefined} decoding={lazy ? 'async' : undefined} /> : <div class={className} style={style} />
}

// A danger button that needs a second tap within a few seconds. Used instead of confirm(), which some embedded
// browsers suppress (it silently returns false).
export function ArmedButton({ label, armedLabel, onConfirm, disabled }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), ARM_CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [armed])
  const tap = () => (armed ? (setArmed(false), onConfirm()) : setArmed(true))
  return <button type="button" class="danger" disabled={disabled} onClick={tap}>{armed ? armedLabel : label}</button>
}

// A QR code's link as text; a tap copies it, to paste into a chat instead of scanning. Not a real link: opening it on
// this same device would pair it with itself.
export function CopyLink({ link }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }
  // Cut in the middle, so the host and the code's end both show: the first part shrinks with an ellipsis, the tail stays.
  const shown = link.replace(/^https?:\/\//, '')
  return (
    <button type="button" class="qr-link" aria-label={copied ? t('Copied') : t('Copy link')} onClick={copy}>
      <span class="qr-link-start">{shown.slice(0, -6)}</span>
      <span>{shown.slice(-6)}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={copied ? 'M5 12.5l4.5 4.5L19 7.5' : 'M9 9h10v10H9zM5 15V5h10'} />
      </svg>
    </button>
  )
}

// A QR code for a link, with the link as text under it. class: the stylesheet's name for the code's box.
export function QrLink({ link, border, class: className }) {
  return (
    <>
      {/* uqr's own output: a static SVG built from our link, no user content. */}
      <div class={className} dangerouslySetInnerHTML={{ __html: renderSVG(link, { border }) }} />
      <CopyLink link={link} />
    </>
  )
}

export const ShareIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m7.5 7.5 4.5-4.5 4.5 4.5" /><path d="M8 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-2" /></svg>
)

export function BackHeader({ title, onBack, children }) {
  return (
    <header class="list-header">
      <button type="button" class="icon-button" aria-label={t('Back')} onClick={onBack}>
        {/* Drawn, not the ‹ character: its font metrics sit it off-centre. */}
        <svg class="back-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6l-6 6 6 6" /></svg>
      </button>
      <h1>{title}</h1>
      {children}
    </header>
  )
}

// Sticker cut-out hasn't been tried on many kinds of sticker yet.
export const Beta = () => <sup class="beta">Beta</sup>

const MAX_ZOOM = 5
const DOUBLE_TAP_ZOOM = 2.5
const DOUBLE_TAP_MS = 300
// Pinch to zoom, drag to pan while zoomed, double-tap to zoom in or back out. Spread the returned props on the
// element; its parent should clip (overflow: hidden). Transforms are set directly, not through state, to keep up with
// the fingers.
export function usePinchZoom() {
  const view = useRef({ scale: 1, x: 0, y: 0 })
  const pointers = useRef(new Map())
  const start = useRef(null)
  const lastTap = useRef({ time: 0, moved: false })

  // Zoom to `scale` keeping the photo point that was under `from` (at the gesture's start) under `to`.
  function zoom(element, scale, from, to) {
    const { origin, view: was } = start.current
    const local = { x: (from.x - origin.x - was.x) / was.scale, y: (from.y - origin.y - was.y) / was.scale }
    const { offsetWidth: width, offsetHeight: height } = element
    const clamp = (value, size) => Math.min(0, Math.max((1 - scale) * size, value))
    view.current = { scale, x: clamp(to.x - origin.x - scale * local.x, width), y: clamp(to.y - origin.y - scale * local.y, height) }
    element.style.transform = scale === 1 ? '' : `translate(${view.current.x}px, ${view.current.y}px) scale(${scale})`
  }

  // Restarts the gesture whenever a finger lands or lifts, so the maths only ever compares against one start.
  function begin(element) {
    const points = [...pointers.current.values()]
    const rect = element.getBoundingClientRect()
    start.current = points.length && {
      origin: { x: rect.left - view.current.x, y: rect.top - view.current.y },
      view: { ...view.current },
      middle: middleOf(points),
      distance: distanceOf(points),
    }
  }

  return {
    style: { touchAction: 'none', transformOrigin: '0 0' },
    onPointerDown(e) {
      e.currentTarget.setPointerCapture?.(e.pointerId)
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      lastTap.current.moved = pointers.current.size > 1
      begin(e.currentTarget)
    },
    onPointerMove(e) {
      if (!pointers.current.has(e.pointerId)) return
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const points = [...pointers.current.values()]
      const from = start.current
      const middle = middleOf(points)
      if (Math.hypot(middle.x - from.middle.x, middle.y - from.middle.y) > 8) lastTap.current.moved = true
      const scale = points.length > 1 ? Math.min(MAX_ZOOM, Math.max(1, (from.view.scale * distanceOf(points)) / from.distance)) : from.view.scale
      if (scale > 1 || from.view.scale > 1) zoom(e.currentTarget, scale, from.middle, middle)
    },
    onPointerUp(e) {
      pointers.current.delete(e.pointerId)
      const element = e.currentTarget
      if (!pointers.current.size && !lastTap.current.moved) {
        const now = Date.now()
        if (now - lastTap.current.time < DOUBLE_TAP_MS) {
          const point = { x: e.clientX, y: e.clientY }
          zoom(element, view.current.scale > 1 ? 1 : DOUBLE_TAP_ZOOM, point, point)
          lastTap.current.time = 0
        } else lastTap.current.time = now
      }
      begin(element)
    },
    onPointerCancel(e) {
      pointers.current.delete(e.pointerId)
      begin(e.currentTarget)
    },
  }
}
const middleOf = (points) => ({ x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length })
const distanceOf = (points) => (points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 1)

const NEW_COLLECTION = '\u0000new'

// Typing a new collection's name. Enter or leaving the field keeps it: onDone(name); Escape or an empty name: onDone(null).
export function NewCollectionInput({ onDone }) {
  return (
    <input
      ref={(element) => element?.focus()} placeholder={t('New collection name')} enterKeyHint="done"
      onBlur={(e) => onDone(e.target.value.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.target.blur() }
        if (e.key === 'Escape') onDone(null)
      }}
    />
  )
}

// A collection: a dropdown of the existing ones (plus No collection), whose last entry turns it into a text field for
// naming a new one.
export function CollectionPicker({ value, events, onChange }) {
  const [creating, setCreating] = useState(false)
  if (creating) return <NewCollectionInput onDone={(name) => { setCreating(false); if (name) onChange(name) }} />
  // A name typed here but not saved yet isn't among the stored collections, so it's listed too.
  const names = value && !events.includes(value) ? [value, ...events] : events
  return (
    <select value={value} onChange={(e) => (e.target.value === NEW_COLLECTION ? setCreating(true) : onChange(e.target.value))}>
      <option value="">{t('No collection')}</option>
      {names.map((name) => <option key={name} value={name}>{name}</option>)}
      <option value={NEW_COLLECTION}>{t('New collection…')}</option>
    </select>
  )
}

// A card's collections, as chips that can be removed, then a menu to add it to another (or a new) one.
export function CollectionChips({ value, events, onChange }) {
  const [creating, setCreating] = useState(false)
  const add = (name) => onChange(value.includes(name) ? value : [...value, name])
  return (
    <div class="collection-chips">
      {value.map((name) => (
        <span class="chip" key={name}>
          {name}
          <button type="button" aria-label={t('Remove from {name}', { name })} onClick={() => onChange(value.filter((other) => other !== name))}>×</button>
        </span>
      ))}
      {creating
        ? <NewCollectionInput onDone={(name) => { setCreating(false); if (name) add(name) }} />
        : (
          // A dropdown is as wide as its longest option, so it lies invisibly over a small button instead.
          <span class="chip-add">
            {value.length ? '+' : `+ ${t('Add to collection')}`}
            <select value="" aria-label={t('Add to collection')} onChange={(e) => (e.target.value === NEW_COLLECTION ? setCreating(true) : add(e.target.value))}>
              <option value="" disabled>{t('Add to collection')}</option>
              {events.filter((name) => !value.includes(name)).map((name) => <option key={name} value={name}>{name}</option>)}
              <option value={NEW_COLLECTION}>{t('New collection…')}</option>
            </select>
          </span>
        )}
    </div>
  )
}

// A button for each other language, named in that language's own words, for someone who can't read this one.
export const LanguageSwitch = ({ class: className }) => Object.entries(LANGUAGES).filter(([code]) => code !== language).map(([code, name]) => (
  <button type="button" key={code} class={className} lang={code} onClick={() => setLanguage(code)}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" /></svg>
    {name}
  </button>
))

// A box with two cards peeking out; stands in for the "Cardbox" title.
export function Logo() {
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label="Cardbox">
      <rect class="logo-back-card" x="6.5" y="3" width="12" height="17" rx="2" transform="rotate(-14 12.5 11.5)" />
      <rect class="logo-front-card" x="13" y="4" width="12" height="17" rx="2" transform="rotate(9 19 12.5)" />
      <path class="logo-box" d="M3 16h26l-2.4 12.4a2 2 0 0 1-2 1.6H7.4a2 2 0 0 1-2-1.6z" />
      <rect class="logo-slot" x="12" y="20" width="8" height="2.4" rx="1.2" />
    </svg>
  )
}
