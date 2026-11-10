// The shuffle animation for a collection's cards: they gather into one stack, a random number of times a random number
// of cards are taken from the bottom of the stack and put on top, and they're dealt from the top of the stack back out
// to their new places. container: the element holding the cards ([data-reorder-id]); ids: the new order (top first);
// save: saves it and asks for a re-render.
// Cuts alone only turn the order round, so the cuts are chosen first and the cards are gathered in the order those cuts
// turn into ids: a gathering stack's order can't be seen, and every cut after it is real.
const GATHER_MS = 380
const CUT_OUT_MS = 100
const CUT_IN_MS = 120
const MIN_CUTS = 7
const MAX_CUTS = 10
const DEAL_MS = 800
const DEAL_SPREAD_MS = 2200
// Kept clear at the bottom of the screen, for the tab bar and camera button floating there.
const BOTTOM_BAR_PX = 90
// px between neighbouring cards in the stack, so it has a visible thickness.
const DEPTH_PX = 0.6

const cardsIn = (container) => [...container.querySelectorAll('[data-reorder-id]')]
const centreOf = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The picture itself: in a fan the card's button is only the visible strip, and the picture runs on past it.
const pictureOf = (element) => element.querySelector('.thumb') ?? element
// Where the stack's middle sits: a card's size in from the bottom right corner of the cards' area, kept to the part on
// screen, so the cards are dealt out from that corner.
function stackCentre(container, card) {
  const rect = container.getBoundingClientRect()
  const bottom = Math.min(rect.bottom, innerHeight - BOTTOM_BAR_PX)
  return { x: rect.right - card.width / 2, y: Math.max(bottom, rect.top + card.height) - card.height / 2 }
}
function offsetToStack(element, stack) {
  const centre = centreOf(pictureOf(element).getBoundingClientRect())
  return { x: stack.x - centre.x, y: stack.y - centre.y }
}
// n cards from the bottom of order put on top.
const cutOf = (order, n) => [...order.slice(order.length - n), ...order.slice(0, order.length - n)]
const uncut = (order, n) => [...order.slice(n), ...order.slice(0, n)]

export async function animateShuffle(container, ids, save) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return save()
  const stack = stackCentre(container, pictureOf(cardsIn(container)[0]).getBoundingClientRect())
  // The cards' layers stay inside the collection, which sits over the collections below it but under the sticky header
  // and the bottom bar.
  Object.assign(container.style, { position: 'relative', zIndex: 4, isolation: 'isolate' })
  const unlayer = () => Object.assign(container.style, { position: '', zIndex: '', isolation: '' })

  const elements = new Map(cardsIn(container).map((element) => [element.dataset.reorderId, element]))
  const offsets = new Map()
  const tilts = new Map()
  const tiltOf = (id) => {
    if (!tilts.has(id)) tilts.set(id, (Math.random() - 0.5) * 10)
    return tilts.get(id)
  }
  // A card's transform at depth (0 the top) in the stack, shifted sideways by `aside` px when the stack is split.
  const inStack = (id, depth, offset, aside = 0) =>
    `translate(${offset.x + aside}px, ${offset.y - depth * DEPTH_PX}px) rotate(${tiltOf(id) + Math.sign(aside) * 4}deg)`
  const current = new Map()
  const running = []
  const move = (id, transform, options) => {
    const element = elements.get(id)
    running.push(element.animate([{ transform: current.get(id) ?? 'none' }, { transform }], { fill: 'both', ...options }))
    current.set(id, transform)
  }
  const layer = (id, depth, count) => { elements.get(id).style.zIndex = 10 + count - depth }

  // Each cut takes between a fifth and three fifths of the stack.
  const count = ids.length
  const cuts = Array.from({ length: MIN_CUTS + Math.floor(Math.random() * (MAX_CUTS - MIN_CUTS + 1)) },
    () => Math.max(1, Math.round(count * (0.2 + Math.random() * 0.4))))
  let order = cuts.reduceRight(uncut, ids)

  // Gather, flying in the order they're shown.
  const shown = [...elements.keys()]
  for (const id of shown) offsets.set(id, offsetToStack(elements.get(id), stack))
  order.forEach((id, depth) => layer(id, depth, count))
  shown.forEach((id, index) => {
    move(id, inStack(id, order.indexOf(id), offsets.get(id)), { duration: GATHER_MS, delay: Math.min(index * 12, 200), easing: 'cubic-bezier(0.4, 0, 0.2, 1)' })
  })
  await wait(GATHER_MS + 200)

  const cardWidth = elements.get(order[0]).querySelector('.thumb')?.getBoundingClientRect().width ?? 100
  // To the left: the stack is against the right edge.
  const aside = -Math.min(cardWidth * 0.7, 110)
  for (const n of cuts) {
    // The bottom n slide out from under the stack, to the side...
    const packet = order.slice(count - n)
    packet.forEach((id, i) => move(id, inStack(id, count - n + i, offsets.get(id), aside), { duration: CUT_OUT_MS, easing: 'ease-out' }))
    await wait(CUT_OUT_MS)
    // ...and come down on top of it.
    order = cutOf(order, n)
    order.forEach((id, depth) => {
      layer(id, depth, count)
      move(id, inStack(id, depth, offsets.get(id)), { duration: CUT_IN_MS, easing: 'ease-in-out' })
    })
    await wait(CUT_IN_MS + 20)
  }

  await save()
  // Wait for the list to show the new order, then, before it's painted, put every card back on the stack, as it was, to
  // deal from there. Cards that changed rows are new elements, so this goes by what's on screen now.
  const landed = await new Promise((resolve) => {
    const started = performance.now()
    const check = () => {
      if (cardsIn(container).map((element) => element.dataset.reorderId).join() === ids.join()) resolve(true)
      else if (performance.now() - started > 3000) resolve(false)
      else requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  })
  for (const animation of running) animation.cancel()
  const dealt = cardsIn(container)
  for (const element of dealt) element.style.zIndex = ''
  if (!landed) return unlayer()
  const spread = Math.min(130, DEAL_SPREAD_MS / dealt.length)
  dealt.forEach((element, index) => {
    const id = element.dataset.reorderId
    // From the top of the stack down. Waiting in the stack, the next card to deal is on top; once it leaves, it goes
    // over the cards dealt before it, as it will lie in the hand, so nothing changes layers when the deal ends.
    element.style.zIndex = 10 + dealt.length - index
    setTimeout(() => { element.style.zIndex = 1000 + index }, index * spread)
    element.animate([{ transform: inStack(id, index, offsetToStack(element, stack)) }, { transform: 'none' }], { duration: DEAL_MS, delay: index * spread, fill: 'backwards', easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
      .finished.then(() => { element.style.zIndex = '' }, () => {})
  })
  setTimeout(unlayer, (dealt.length - 1) * spread + DEAL_MS)
}
