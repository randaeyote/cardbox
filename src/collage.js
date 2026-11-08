import { scaledCanvas } from './crop.js'
const COLLAGE_SIZE = 2800
export const DEFAULT_FILL = '#1b1b1e'
// Cards are sized so that together they cover about 0.8× the photo's area. Tuned by measuring piles of 6–100 cards:
// every card stays at least ~70% visible, with small even gaps.
const PILE_AREA = 0.8125
// Space between a card's front and back when they're shown as a pair, as a share of a card's long side.
const PAIR_GAP = 0.04
// Within a pair, each card is drawn a little askew and the two are nudged together, so they look dropped rather than
// placed: up to this much extra tilt (degrees), overlap and sideways slip (card long sides).
const PAIR_TILT = 6
const PAIR_MAX_OVERLAP = 0.08
const PAIR_SLIP = 0.04
// A sticker's longest side, as a share of a card's long side, unless the sticker sets its own `size`.
export const DEFAULT_STICKER_SIZE = 0.6
// A few cards would otherwise be drawn huge; cap a card's long side to a share of the photo.
const MAX_LONG_SIDE_FRACTION = 0.42
// Neighbouring cards are pushed apart until they overlap by at most this share of their extent toward each other.
// Adjustable (0 to MAX_OVERLAP_LIMIT); cards grow with it so the photo stays covered.
export const DEFAULT_OVERLAP = 0.12
export const MAX_OVERLAP_LIMIT = 0.4
const RELAX_STEPS = 220
// Only for small hauls, whose capped cards can't fill the photo: pulls them into a pile in the middle instead.
const GRAVITY = 0.015
// Most a card is turned either way, in degrees. Adjustable from 0 (all straight) to MAX_TILT_LIMIT.
export const DEFAULT_TILT = 16
export const MAX_TILT_LIMIT = 35
// Card thumbnails are cached at this long side; plenty for a card drawn a few hundred pixels across.
const THUMBNAIL_DIMENSION = 700

// Small deterministic generator, so Shuffle can re-roll by changing the seed and a layout can be reproduced.
export function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Lays out items as a pile over a width × height canvas. shapes are the items' { width, height } measured in card long
// sides: a single landscape card is 1 × 0.625, a front-and-back pair about twice that. Items start at random spots,
// then are repeatedly pushed apart where they overlap too much, inside the photo's edges; sized to fill the photo,
// they spread out evenly with small overlaps and no gaps. Every card gets the same long side, as real cards do.
// Returns { longSide, placements: [{ index, x, y, angle }] } in drawing order; longSide is a card's long side in
// pixels, and x, y are item centres.
export function scatterLayout(shapes, width, height, random, { tilt = DEFAULT_TILT, overlap = DEFAULT_OVERLAP } = {}) {
  const count = shapes.length
  if (!count) return { longSide: 0, placements: [] }
  const totalArea = shapes.reduce((sum, { width, height }) => sum + width * height, 0)
  // Each card's share of the photo shrinks by (1 - overlap) each way, so grow cards to match the tuned default.
  const pileArea = PILE_AREA * ((1 - DEFAULT_OVERLAP) / (1 - overlap)) ** 2
  const fillingSide = Math.sqrt((pileArea * width * height) / totalArea)
  const longSide = Math.min(Math.sqrt(width * height) * MAX_LONG_SIDE_FRACTION, fillingSide)
  const gravity = longSide < fillingSide ? GRAVITY : 0
  const cards = shapes.map((shape, index) => {
    const angle = (random() * 2 - 1) * tilt
    const radians = (angle * Math.PI) / 180
    return {
      index, angle, halfWidth: (shape.width * longSide) / 2, halfHeight: (shape.height * longSide) / 2,
      cos: Math.cos(radians), sin: Math.sin(radians),
      x: width * (0.15 + 0.7 * random()), y: height * (0.15 + 0.7 * random()),
    }
  })
  for (let step = 0; step < RELAX_STEPS; step++) {
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const a = cards[i]
        const b = cards[j]
        let dx = b.x - a.x
        let dy = b.y - a.y
        let distance = Math.hypot(dx, dy)
        if (distance < 1e-6) { dx = random() - 0.5; dy = random() - 0.5; distance = Math.hypot(dx, dy) }
        const ux = dx / distance
        const uy = dy / distance
        const wanted = (1 - overlap) * (reach(a, ux, uy) + reach(b, ux, uy))
        if (distance >= wanted) continue
        const push = (wanted - distance) / 2
        a.x -= ux * push; a.y -= uy * push
        b.x += ux * push; b.y += uy * push
      }
    }
    for (const card of cards) {
      card.x += (width / 2 - card.x) * gravity
      card.y += (height / 2 - card.y) * gravity
      const reachX = reach(card, 1, 0)
      const reachY = reach(card, 0, 1)
      card.x = Math.min(width - reachX, Math.max(reachX, card.x))
      card.y = Math.min(height - reachY, Math.max(reachY, card.y))
    }
  }
  const placements = cards.map(({ index, x, y, angle }) => ({ index, x, y, angle }))
  return { longSide, placements: shuffle(placements, random) }
}

// Tidy look: straight cards packed edge to edge with a gap between them, as a share of a card's long side.
export const DEFAULT_TIDY_GAP = 0.02
export const MAX_TIDY_GAP = 0.08
// Orders of the cards tried per layout, each with a binary search on card size; the biggest wins. Measured on 70–110
// items: more of either hardly helps.
const TIDY_ORDERS = 20
const TIDY_SEARCH_STEPS = 12

// Packs items straight, with even gaps, as big as they'll go: MaxRects (see packMaxRects) inside a binary search on
// card size, over several shuffled orders. The best packing is NP-hard to find; this gets most of the way (about 82%
// of the photo is card at a 2% gap). Same result shape as scatterLayout, centred, plus each pair's members as arranged.
export function tidyLayout(shapes, width, height, random, { gap = DEFAULT_TIDY_GAP } = {}) {
  if (!shapes.length) return { longSide: 0, placements: [] }
  const variants = shapes.map((shape) => tidyVariants(shape, gap))
  const isSticker = (shape) => !!shape.members?.[0].sticker
  const cards = [...shapes.keys()].filter((index) => !isSticker(shapes[index]))
  const stickers = [...shapes.keys()].filter((index) => isSticker(shapes[index]))
  const totalArea = shapes.reduce((sum, shape) => sum + shape.width * shape.height, 0)
  const maxSide = Math.min(Math.sqrt(width * height) * MAX_LONG_SIDE_FRACTION, Math.sqrt((width * height) / totalArea))
  let best = { longSide: 0, spots: null }
  for (let attempt = 0; attempt < TIDY_ORDERS; attempt++) {
    // Mostly random orders, for variety between layout numbers; tallest-first packs rows most evenly, so it's in
    // the running too. Stickers go last, so they drop into the notches cards leave (beside the short side of a
    // front-and-back pair in different orientations), which no card fits.
    const order = [cards, stickers].flatMap((indexes) => (attempt === 0
      ? [...indexes].sort((a, b) => shapes[b].height - shapes[a].height || random() - 0.5)
      : shuffle([...indexes], random)))
    let low = best.longSide || maxSide / 4
    let high = maxSide
    // Only worth searching if this order can beat the best so far.
    const first = packMaxRects(variants, order, low, width, height, gap)
    if (!first) continue
    if (!best.spots) best = { longSide: low, spots: first }
    for (let step = 0; step < TIDY_SEARCH_STEPS; step++) {
      const middle = (low + high) / 2
      const spots = packMaxRects(variants, order, middle, width, height, gap)
      if (spots) { low = middle; if (middle > best.longSide) best = { longSide: middle, spots } } else high = middle
    }
  }
  const { longSide, spots } = best
  const parts = spots.flatMap((spot) => spot.parts)
  const shiftX = (width - Math.max(...parts.map((part) => part.x + part.width)) - Math.min(...parts.map((part) => part.x))) / 2
  const shiftY = (height - Math.max(...parts.map((part) => part.y + part.height)) - Math.min(...parts.map((part) => part.y))) / 2
  return {
    longSide,
    placements: spots.map(({ index, x, y, variant }) => ({
      index, angle: 0,
      x: x + (variant.width * longSide) / 2 + shiftX, y: y + (variant.height * longSide) / 2 + shiftY,
      members: variant.members,
    })),
  }
}

// The ways an item may be arranged, in card long sides. A single card is as it is. A front-and-back pair's back may
// touch its front on any side, flush with either end of that edge; pairs whose sides differ in orientation are then
// L-shaped, and the packing fills the notch. Within a pair the gap is half the usual, so the two read as a pair.
// ponytail: flush only; letting the back slide anywhere along the edge measured no bigger cards at twice the time.
// Each variant: { width, height, members (centred, as collageItems gives them), parts: member boxes from its top-left }.
function tidyVariants(shape, gap) {
  const members = shape.members ?? [{ width: shape.width, height: shape.height, x: 0, y: 0 }]
  if (members.length === 1) return [{ width: shape.width, height: shape.height, members, parts: [{ dx: 0, dy: 0, width: shape.width, height: shape.height }] }]
  const [a, b] = members
  const between = gap / 2
  const offsets = [
    ...[0, a.width - b.width].flatMap((dx) => [{ dx, dy: a.height + between }, { dx, dy: -b.height - between }]),
    ...[0, a.height - b.height].flatMap((dy) => [{ dx: a.width + between, dy }, { dx: -b.width - between, dy }]),
  ]
  return offsets.map(({ dx, dy }) => {
    const left = Math.min(0, dx)
    const top = Math.min(0, dy)
    const width = Math.max(a.width, dx + b.width) - left
    const height = Math.max(a.height, dy + b.height) - top
    const parts = [
      { dx: -left, dy: -top, width: a.width, height: a.height },
      { dx: dx - left, dy: dy - top, width: b.width, height: b.height },
    ]
    return {
      width, height, parts,
      members: [a, b].map((member, i) => ({ ...member, x: parts[i].dx + member.width / 2 - width / 2, y: parts[i].dy + member.height / 2 - height / 2 })),
    }
  })
}

// Places items in `order` at this card size, or null if they don't all fit. MaxRects: the empty space is kept as
// every largest empty rectangle (they overlap), so holes left under or beside earlier cards stay usable. Each item,
// in whichever of its variants does best, goes with one of its parts in an empty rectangle's top-left corner, where
// all its parts are free; the lowest bottom edge wins, then leftmost.
function packMaxRects(variants, order, longSide, width, height, gapShare) {
  const gap = gapShare * longSide
  const limitX = width + gap
  const limitY = height + gap
  const epsilon = 1e-6
  // Empty rectangles too small for any card can never be used; dropping them keeps the list short.
  const smallest = Math.min(...variants.flat().flatMap((variant) => variant.parts.map((part) => Math.min(part.width, part.height)))) * longSide + gap
  let free = [{ x: 0, y: 0, width: limitX, height: limitY }]
  const isFree = (x, y, w, h) => free.some((f) => x >= f.x - epsilon && y >= f.y - epsilon && x + w <= f.x + f.width + epsilon && y + h <= f.y + f.height + epsilon)
  const spots = []
  for (const index of order) {
    let chosen = null
    for (const variant of variants[index]) {
      const parts = variant.parts.map(({ dx, dy, width, height }) => ({ dx: dx * longSide, dy: dy * longSide, width: width * longSide + gap, height: height * longSide + gap }))
      for (const f of free) {
        for (const anchor of parts) {
          if (anchor.width > f.width + epsilon || anchor.height > f.height + epsilon) continue
          const x = f.x - anchor.dx
          const y = f.y - anchor.dy
          if (x < -epsilon || y < -epsilon) continue
          const bottom = Math.max(...parts.map((part) => y + part.dy + part.height))
          if (chosen && (bottom > chosen.bottom + epsilon || (bottom > chosen.bottom - epsilon && x >= chosen.x))) continue
          if (!parts.every((part) => part === anchor || isFree(x + part.dx, y + part.dy, part.width, part.height))) continue
          chosen = { x, y, bottom, variant, parts }
        }
      }
    }
    if (!chosen) return null
    const { x, y, variant, parts } = chosen
    for (const part of parts) free = carve(free, { x: x + part.dx, y: y + part.dy, width: part.width, height: part.height }, smallest)
    spots.push({
      index, x, y, variant,
      parts: parts.map((part) => ({ x: x + part.dx, y: y + part.dy, width: part.width - gap, height: part.height - gap })),
    })
  }
  return spots
}

// The empty rectangles once `used` is taken: each one it cuts into is replaced by the up-to-four largest pieces
// around it, then any piece inside another (or too small to use) is dropped.
function carve(free, used, smallest) {
  const pieces = []
  for (const f of free) {
    if (used.x >= f.x + f.width || used.x + used.width <= f.x || used.y >= f.y + f.height || used.y + used.height <= f.y) { pieces.push(f); continue }
    if (used.x > f.x) pieces.push({ ...f, width: used.x - f.x })
    if (used.x + used.width < f.x + f.width) pieces.push({ ...f, x: used.x + used.width, width: f.x + f.width - used.x - used.width })
    if (used.y > f.y) pieces.push({ ...f, height: used.y - f.y })
    if (used.y + used.height < f.y + f.height) pieces.push({ ...f, y: used.y + used.height, height: f.y + f.height - used.y - used.height })
  }
  const usable = pieces.filter((piece) => piece.width >= smallest - 1e-6 && piece.height >= smallest - 1e-6)
  const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height
  return usable.filter((a, i) => !usable.some((b, j) => j !== i && inside(a, b) && (!inside(b, a) || j < i)))
}

// How far a tilted card extends from its centre in direction (ux, uy).
export const reach = (card, ux, uy) =>
  Math.abs(ux * card.cos + uy * card.sin) * card.halfWidth + Math.abs(-ux * card.sin + uy * card.cos) * card.halfHeight

function shuffle(items, random) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

// Decodes each given image (fronts and backs alike) once at a modest size, so re-shuffling doesn't re-decode full photos and a big haul
// doesn't hold dozens of full-size images in memory at once.
export async function loadThumbnails(blobs) {
  const thumbnails = []
  for (const blob of blobs) {
    const bitmap = await createImageBitmap(blob)
    thumbnails.push(scaledCanvas(bitmap, THUMBNAIL_DIMENSION))
    bitmap.close?.()
  }
  return thumbnails
}

// Turns card thumbnails into layout items, measured in card long sides. A card with a back shown becomes one pair
// item, so the back always lands next to its front: stacked for landscape fronts, side by side for portrait ones,
// which keeps pairs roughly square and lets them pack like single cards.
// sides: [{ front: canvas, back: canvas | null, frontRadius?, backRadius?, sticker?, size? }], the radii as measured by
// measureCorners; a sticker is drawn by its own outline, not as a
// card, with its long side `size` card long sides.
export function collageItems(sides) {
  const card = (image, radius) => {
    const long = Math.max(image.width, image.height)
    return { image, width: image.width / long, height: image.height / long, radius }
  }
  return sides.map(({ front, back, frontRadius, backRadius, sticker, size: stickerSize = DEFAULT_STICKER_SIZE }) => {
    if (sticker) {
      const { image, width, height } = card(front)
      const size = { width: width * stickerSize, height: height * stickerSize }
      return { ...size, members: [{ image, ...size, x: 0, y: 0, sticker }] }
    }
    const first = card(front, frontRadius)
    if (!back) return { width: first.width, height: first.height, members: [{ ...first, x: 0, y: 0 }] }
    const second = card(back, backRadius)
    if (first.width >= first.height) {
      const height = first.height + PAIR_GAP + second.height
      return {
        width: Math.max(first.width, second.width), height,
        members: [{ ...first, x: 0, y: -height / 2 + first.height / 2 }, { ...second, x: 0, y: height / 2 - second.height / 2 }],
      }
    }
    const width = first.width + PAIR_GAP + second.width
    return {
      width, height: Math.max(first.height, second.height),
      members: [{ ...first, x: -width / 2 + first.width / 2, y: 0 }, { ...second, x: width / 2 - second.width / 2, y: 0 }],
    }
  })
}

// A collage is built in layers, so changing the background doesn't redo the slow parts: drawCards lays the cards out on
// a see-through canvas; warpLayer (optional) tips that onto a surface; composeCollage puts it over the background.

// aspect is width / height; the image's longer side is COLLAGE_SIZE. options: { tilt, overlap } as for scatterLayout,
// or { tidy: true, gap } for tidyLayout; scale: the share of the image the cards are laid out in, centred, so more of
// the background shows round them.
export function drawCards(items, seed, aspect = 1, options = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(COLLAGE_SIZE * Math.min(1, aspect))
  canvas.height = Math.round(COLLAGE_SIZE / Math.max(1, aspect))
  const context = canvas.getContext('2d')
  const scale = options.scale ?? 1
  const areaWidth = canvas.width * scale
  const areaHeight = canvas.height * scale
  context.translate((canvas.width - areaWidth) / 2, (canvas.height - areaHeight) / 2)
  const { longSide, placements } = options.tidy
    ? tidyLayout(items, areaWidth, areaHeight, seededRandom(seed), options)
    : scatterLayout(items, areaWidth, areaHeight, seededRandom(seed), options)
  // A pair's own askew look follows the tilt setting, so tilt 0 gives a straight layout; tidy has none at all.
  const pairTilt = PAIR_TILT * ((options.tilt ?? DEFAULT_TILT) / DEFAULT_TILT)
  const loose = options.tidy ? 0 : 1
  // A separate stream, so the pair jitter doesn't change the pile layout for the same seed.
  const jitter = seededRandom(seed ^ 0x9e3779b9)
  const between = (limit) => (jitter() * 2 - 1) * limit
  const radius = longSide * 0.03
  for (const placement of placements) {
    const { index, x, y, angle } = placement
    context.save()
    context.translate(x, y)
    context.rotate((angle * Math.PI) / 180)
    let members = placement.members ?? items[index].members
    if (members.length === 2) {
      const stacked = members[0].x === members[1].x
      const overlap = jitter() * PAIR_MAX_OVERLAP * loose
      members = members.map((member, i) => {
        // Slide each card toward the other along the pair, and a little across it.
        const inward = (i === 0 ? 1 : -1) * (overlap / 2)
        const slip = between(PAIR_SLIP) * loose
        return {
          ...member,
          x: member.x + (stacked ? slip : inward),
          y: member.y + (stacked ? inward : slip),
          tilt: between(pairTilt) * loose,
        }
      })
      // Either card may land on top.
      if (jitter() < 0.5) members = [members[1], members[0]]
    }
    for (const member of members) {
      const width = member.width * longSide
      const height = member.height * longSide
      context.save()
      context.translate(member.x * longSide, member.y * longSide)
      context.rotate(((member.tilt ?? 0) * Math.PI) / 180)
      const left = -width / 2
      const top = -height / 2
      context.shadowColor = 'rgb(0 0 0 / 0.55)'
      context.shadowBlur = longSide * 0.06
      context.shadowOffsetY = longSide * 0.02
      if (member.sticker) {
        // The shadow follows the cut-out's transparency, so it hugs the sticker's own shape.
        context.drawImage(member.image, left, top, width, height)
        context.restore()
        continue
      }
      context.beginPath()
      context.roundRect(left, top, width, height, member.radius ? member.radius.x * width : radius)
      context.fillStyle = '#fff'
      context.fill()
      context.shadowColor = 'transparent'
      context.clip()
      context.drawImage(member.image, left, top, width, height)
      context.restore()
    }
    context.restore()
  }
  return canvas
}

// fill: the background colour, or null for see-through; background: a photo instead, cropped to fill.
export function composeCollage(canvas, layer, { fill = DEFAULT_FILL, background = null } = {}) {
  canvas.width = layer.width
  canvas.height = layer.height
  const context = canvas.getContext('2d')
  if (background) {
    const scale = Math.max(canvas.width / background.width, canvas.height / background.height)
    context.drawImage(background, (canvas.width - background.width * scale) / 2, (canvas.height - background.height * scale) / 2, background.width * scale, background.height * scale)
  } else if (fill) {
    context.fillStyle = fill
    context.fillRect(0, 0, canvas.width, canvas.height)
  }
  context.drawImage(layer, 0, 0)
}

// corners: top-left, top-right, bottom-right, bottom-left, as shares of the image, to tip the cards onto so they lie
// on a table in the background photo.
export function warpLayer(cv, layer, corners) {
  const { width, height } = layer
  const mats = []
  const track = (mat) => (mats.push(mat), mat)
  try {
    const input = track(cv.imread(layer))
    const from = track(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]))
    const to = track(cv.matFromArray(4, 1, cv.CV_32FC2, corners.flatMap(({ x, y }) => [x * width, y * height])))
    const transform = track(cv.getPerspectiveTransform(from, to))
    const output = track(new cv.Mat())
    cv.warpPerspective(input, output, transform, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0))
    const out = document.createElement('canvas')
    cv.imshow(out, output)
    return out
  } finally {
    mats.forEach((mat) => mat.delete())
  }
}
