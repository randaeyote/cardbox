import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

// How long a finger holds still before a card lifts. Moving further than SLOP_PX first means it's a scroll (touch) or
// starts the drag right away (mouse).
const HOLD_MS = 400
const SLOP_PX = 8
// Near the top or bottom of the screen the page scrolls, faster the closer the pointer is to the edge.
const EDGE_PX = 80
const MAX_SCROLL_PX = 14

// Drag-to-reorder cards within their group, by mouse or finger. The lifted card follows the pointer and the others
// shift as it passes over them. Rows carry rowProps(group key, group ids, id); drag is { group, id, ids } with ids
// the group's live order while a card is lifted, else null. onDrop(ids, group) gets the new order.
export function useReorder(onDrop) {
  const [drag, setDrag] = useState(null)
  // The gesture in progress, in a ref because pointer events fire faster than re-renders.
  const gesture = useRef(null)

  // The lifted card's slot moves as the order changes; keep it under the pointer after each re-render. Moved into
  // another compact hand, it's a new element.
  useLayoutEffect(() => {
    const g = gesture.current
    if (!g?.lifted) return
    // By group too: a card in two collections is in the list twice.
    g.element = document.querySelector(`[data-reorder-group="${CSS.escape(g.group)}"][data-reorder-id="${CSS.escape(g.id)}"]`) ?? g.element
    place(g)
  }, [drag])

  useEffect(() => {
    // Once a card is lifted, a finger moving must drag it, not scroll the page. Only a non-passive touchmove
    // listener can stop iOS from scrolling.
    const holdPage = (e) => gesture.current?.lifted && e.preventDefault()
    document.addEventListener('touchmove', holdPage, { passive: false })
    return () => {
      document.removeEventListener('touchmove', holdPage)
      finish(false)
    }
  }, [])

  function place(g) {
    g.element.style.transform = ''
    const rect = g.element.getBoundingClientRect()
    g.element.style.transform = `translate(${g.x - g.offsetX - rect.left}px, ${g.y - g.offsetY - rect.top}px) scale(1.04)`
  }

  // Put the lifted card where the hovered one in its group is, shifting the rest along.
  function hover(g) {
    // The card whose own box is under the pointer, not merely one drawn there: in a compact hand each card spills under
    // the next, and taking the spilled-over card as the target swapped the dragged card back and forth.
    const target = document.elementsFromPoint(g.x, g.y)
      .map((element) => element.closest('[data-reorder-id]'))
      .find((card) => {
        const box = card?.getBoundingClientRect()
        return box && g.x >= box.left && g.x < box.right && g.y >= box.top && g.y < box.bottom
      })
    if (!target || target.dataset.reorderGroup !== g.group || target.dataset.reorderId === g.id) return
    const ids = g.ids.filter((id) => id !== g.id)
    ids.splice(g.ids.indexOf(target.dataset.reorderId), 0, g.id)
    if (ids.join() === g.ids.join()) return
    g.ids = ids
    setDrag({ group: g.group, id: g.id, ids })
  }

  function lift(g) {
    g.lifted = true
    const rect = g.element.getBoundingClientRect()
    g.offsetX = g.x - rect.left
    g.offsetY = g.y - rect.top
    setDrag({ group: g.group, id: g.id, ids: g.ids })
    const scroll = () => {
      const speed = g.y < EDGE_PX ? g.y - EDGE_PX : g.y > innerHeight - EDGE_PX ? g.y - (innerHeight - EDGE_PX) : 0
      if (speed) {
        scrollBy(0, (Math.max(-EDGE_PX, Math.min(EDGE_PX, speed)) / EDGE_PX) * MAX_SCROLL_PX)
        hover(g)
        place(g)
      }
      g.frame = requestAnimationFrame(scroll)
    }
    g.frame = requestAnimationFrame(scroll)
  }

  function finish(save) {
    const g = gesture.current
    if (!g) return
    gesture.current = null
    clearTimeout(g.timer)
    cancelAnimationFrame(g.frame)
    for (const [type, listener] of g.listeners) removeEventListener(type, listener)
    if (!g.lifted) return
    g.element.style.transform = ''
    setDrag(null)
    // The click that ends a drag would otherwise open whichever card is under the pointer.
    const swallow = (e) => { e.stopPropagation(); e.preventDefault() }
    addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => removeEventListener('click', swallow, { capture: true }))
    if (save && g.ids.join() !== g.start.join()) onDrop(g.ids, g.group)
  }

  function move(e) {
    const g = gesture.current
    if (e.pointerId !== g.pointerId) return
    g.x = e.clientX
    g.y = e.clientY
    if (g.lifted) {
      hover(g)
      place(g)
    } else if (Math.hypot(g.x - g.startX, g.y - g.startY) > SLOP_PX) {
      if (e.pointerType === 'mouse') lift(g)
      else finish(false)
    }
  }
  const up = () => finish(true)
  const cancel = () => finish(false)

  const rowProps = (group, ids, id) => ({
    'data-reorder-group': group,
    'data-reorder-id': id,
    onPointerDown: (e) => {
      if (e.button !== 0 || gesture.current || e.target.closest('a')) return
      const g = { pointerId: e.pointerId, element: e.currentTarget, group, id, ids, start: ids, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY }
      gesture.current = g
      if (e.pointerType !== 'mouse') g.timer = setTimeout(() => lift(g), HOLD_MS)
      // Kept on the gesture: a re-render mid-drag makes new copies of these functions.
      g.listeners = [['pointermove', move], ['pointerup', up], ['pointercancel', cancel]]
      for (const [type, listener] of g.listeners) addEventListener(type, listener)
    },
    // The browser's own image dragging and long-press menu would take over the gesture.
    onDragStart: (e) => e.preventDefault(),
    onContextMenu: (e) => gesture.current && e.preventDefault(),
  })

  return { drag, rowProps }
}
