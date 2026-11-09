import assert from 'node:assert/strict'
import { scatterLayout, tidyLayout, seededRandom, reach, collageItems, repeatItems } from './collage.js'

const SIZE = 2800
// The short side of a 9:16 image.
const NARROW = 1575
const shapesFor = (count, random) =>
  Array.from({ length: count }, () => (random() < 0.5 ? { width: 1, height: 0.625 } : { width: 0.625, height: 1 }))

function placedCards(shapes, layout) {
  return layout.placements.map(({ index, x, y, angle }) => {
    const radians = (angle * Math.PI) / 180
    return { x, y, cos: Math.cos(radians), sin: Math.sin(radians), halfWidth: (shapes[index].width * layout.longSide) / 2, halfHeight: (shapes[index].height * layout.longSide) / 2 }
  })
}
const covers = (card, px, py) => {
  const dx = px - card.x
  const dy = py - card.y
  return Math.abs(dx * card.cos + dy * card.sin) <= card.halfWidth && Math.abs(-dx * card.sin + dy * card.cos) <= card.halfHeight
}
// Share of a card's face not hidden by cards drawn after it, sampled on a 20 × 20 grid.
function visibleShare(cards, i) {
  const card = cards[i]
  let seen = 0
  let total = 0
  for (let a = -0.95; a <= 0.95; a += 0.1) {
    for (let b = -0.95; b <= 0.95; b += 0.1) {
      const px = card.x + a * card.halfWidth * card.cos - b * card.halfHeight * card.sin
      const py = card.y + a * card.halfWidth * card.sin + b * card.halfHeight * card.cos
      total++
      if (!cards.slice(i + 1).some((other) => covers(other, px, py))) seen++
    }
  }
  return seen / total
}

for (const [count, width, height] of [1, 2, 6, 23, 100].flatMap((count) => [[count, SIZE, SIZE], [count, NARROW, SIZE], [count, SIZE, NARROW]])) {
  const shapes = shapesFor(count, seededRandom(count))
  const layout = scatterLayout(shapes, width, height, seededRandom(42))
  assert.equal(layout.placements.length, count)
  assert.deepEqual(layout.placements.map((p) => p.index).sort((a, b) => a - b), [...Array(count).keys()])
  const cards = placedCards(shapes, layout)
  cards.forEach((card, i) => {
    assert.ok(card.x - reach(card, 1, 0) >= -1 && card.x + reach(card, 1, 0) <= width + 1, `card ${i} runs off a side`)
    assert.ok(card.y - reach(card, 0, 1) >= -1 && card.y + reach(card, 0, 1) <= height + 1, `card ${i} runs off the top or bottom`)
    // The complaint this guards: some cards buried under others.
    assert.ok(visibleShare(cards, i) >= 0.55, `card ${i} of ${count} (${width}×${height}) is only ${Math.round(visibleShare(cards, i) * 100)}% visible`)
  })
  if (count >= 6) {
    // ...and big empty patches: most of the photo should be card.
    let covered = 0
    let samples = 0
    for (let px = 35; px < width; px += 70) for (let py = 35; py < height; py += 70) { samples++; if (cards.some((card) => covers(card, px, py))) covered++ }
    assert.ok(covered / samples >= 0.6, `only ${Math.round((covered / samples) * 100)}% of the photo is covered with ${count} cards`)
  }
}
// The tilt and overlap sliders' extremes: cards stay inside the photo and still cover most of it.
for (const options of [{ tilt: 0, overlap: 0 }, { tilt: 35, overlap: 0 }, { tilt: 0, overlap: 0.4 }, { tilt: 35, overlap: 0.4 }]) {
  const shapes = shapesFor(23, seededRandom(23))
  const layout = scatterLayout(shapes, SIZE, SIZE, seededRandom(42), options)
  const cards = placedCards(shapes, layout)
  cards.forEach((card, i) => {
    assert.ok(card.x - reach(card, 1, 0) >= -1 && card.x + reach(card, 1, 0) <= SIZE + 1, `card ${i} runs off a side with ${JSON.stringify(options)}`)
    assert.ok(card.y - reach(card, 0, 1) >= -1 && card.y + reach(card, 0, 1) <= SIZE + 1, `card ${i} runs off the top or bottom with ${JSON.stringify(options)}`)
  })
  let covered = 0
  let samples = 0
  for (let px = 35; px < SIZE; px += 70) for (let py = 35; py < SIZE; py += 70) { samples++; if (cards.some((card) => covers(card, px, py))) covered++ }
  assert.ok(covered / samples >= 0.6, `only ${Math.round((covered / samples) * 100)}% covered with ${JSON.stringify(options)}`)
  if (options.tilt === 0) assert.ok(layout.placements.every((p) => p.angle === 0))
}
const sample = shapesFor(9, seededRandom(9))
assert.deepEqual(scatterLayout(sample, SIZE, SIZE, seededRandom(7)), scatterLayout(sample, SIZE, SIZE, seededRandom(7)))
assert.notDeepEqual(scatterLayout(sample, SIZE, SIZE, seededRandom(7)), scatterLayout(sample, SIZE, SIZE, seededRandom(8)))
assert.deepEqual(scatterLayout([], SIZE, SIZE, seededRandom(1)), { longSide: 0, placements: [] })
// Pairs: a landscape front stacks its back below it; a portrait front puts its back beside it.
const image = (width, height) => ({ width, height })
const [landscapePair, portraitPair, single] = collageItems([
  { front: image(1600, 1000), back: image(1600, 1000) },
  { front: image(1000, 1600), back: image(1000, 1600) },
  { front: image(1600, 1000), back: null },
])
assert.deepEqual([landscapePair.width, +landscapePair.height.toFixed(3)], [1, 1.29])
assert.ok(landscapePair.members[0].y < 0 && landscapePair.members[1].y > 0 && landscapePair.members.every((m) => m.x === 0))
assert.deepEqual([+portraitPair.width.toFixed(3), portraitPair.height], [1.29, 1])
assert.ok(portraitPair.members[0].x < 0 && portraitPair.members[1].x > 0)
assert.equal(single.members.length, 1)
// A sticker keeps its flag, so it's drawn by its outline instead of as a white card...
const sticker = collageItems([{ front: image(900, 1000), back: null, sticker: true }])[0]
assert.equal(sticker.members[0].sticker, true)
// ...and is drawn at 60% of a card's size by default, or at its own size.
assert.deepEqual([sticker.width, sticker.height], [0.54, 0.6])
const big = collageItems([{ front: image(900, 1000), back: null, sticker: true, size: 0.8 }])[0]
assert.deepEqual([big.width, big.height].map((size) => +size.toFixed(3)), [0.72, 0.8])
// A single card in a mixed pile is the same size as each card of a pair.
const mixed = scatterLayout([landscapePair, single], SIZE, SIZE, seededRandom(5))
assert.ok(mixed.longSide > 0)
console.log('collage tests passed')

// Tidy: no card overlaps another, everything is inside, and the cards cover most of the photo. Every fifth item is a
// sticker and every third a front-and-back pair, some with sides in different orientations.
for (const [count, width, height] of [[1, SIZE, SIZE], [6, SIZE, SIZE], [23, NARROW, SIZE], [88, SIZE, 2240], [100, SIZE, NARROW]]) {
  const random = seededRandom(count)
  const image = (portrait) => (portrait ? { width: 625, height: 1000 } : { width: 1000, height: 625 })
  const items = collageItems(Array.from({ length: count }, (_, i) => ({
    front: image(random() < 0.5), back: i % 3 === 2 ? image(random() < 0.5) : null, sticker: i % 5 === 4,
  })))
  const layout = tidyLayout(items, width, height, seededRandom(7))
  assert.deepEqual(layout.placements.map((p) => p.index).sort((a, b) => a - b), [...Array(count).keys()])
  const boxes = layout.placements.flatMap(({ index, x, y, members }) => (members ?? [{ ...items[index], x: 0, y: 0 }]).map((member) => ({
    x: x + member.x * layout.longSide, y: y + member.y * layout.longSide, w: (member.width * layout.longSide) / 2, h: (member.height * layout.longSide) / 2,
  })))
  for (const [i, a] of boxes.entries()) {
    assert.ok(a.x - a.w >= -1 && a.x + a.w <= width + 1 && a.y - a.h >= -1 && a.y + a.h <= height + 1, `tidy card ${i} runs off the photo`)
    for (const b of boxes.slice(i + 1)) assert.ok(Math.abs(a.x - b.x) >= a.w + b.w - 1 || Math.abs(a.y - b.y) >= a.h + b.h - 1, 'tidy cards overlap')
  }
  const covered = boxes.reduce((sum, { w, h }) => sum + 4 * w * h, 0) / (width * height)
  if (count >= 23) assert.ok(covered >= 0.7, `tidy covers only ${Math.round(covered * 100)}% with ${count} cards`)
  console.log(`  tidy ${count} items ${width}×${height}: ${Math.round(covered * 100)}% covered`)
}

// Repeating: exactly the count asked for, each item within one of every other's tally; never fewer than the items.
{
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  const repeated = repeatItems(items, 100, seededRandom(1))
  assert.equal(repeated.length, 100)
  const tallies = items.map((item) => repeated.filter((each) => each === item).length)
  assert.ok(Math.max(...tallies) - Math.min(...tallies) <= 1, `uneven: ${tallies}`)
  assert.deepEqual(repeatItems(items, 3, seededRandom(1)), items)
}
