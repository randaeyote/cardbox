import assert from 'node:assert/strict'
import { orderCorners, outputSize, enhancePixels, segmentToLine, findBestQuad, refineQuad } from './crop.js'

const [topLeft, topRight, bottomRight, bottomLeft] = [{ x: 10, y: 10 }, { x: 110, y: 20 }, { x: 100, y: 70 }, { x: 5, y: 60 }]
const expected = [topLeft, topRight, bottomRight, bottomLeft]
assert.deepEqual(orderCorners([bottomRight, topLeft, bottomLeft, topRight]), expected)
assert.deepEqual(orderCorners([bottomLeft, topRight, topLeft, bottomRight]), expected)

// Card rotated ~30 degrees clockwise.
const rotated = [{ x: 20, y: 0 }, { x: 120, y: 40 }, { x: 100, y: 90 }, { x: 0, y: 50 }]
assert.deepEqual(orderCorners([rotated[2], rotated[0], rotated[3], rotated[1]]), rotated)

assert.deepEqual(outputSize([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 0, y: 200 }]), { width: 300, height: 200 })
assert.deepEqual(
  outputSize([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 320, y: 200 }, { x: 0, y: 190 }]),
  { width: 320, height: 201 },
)
assert.deepEqual(outputSize([{ x: 0, y: 0 }, { x: 4800, y: 0 }, { x: 4800, y: 3000 }, { x: 0, y: 3000 }]), { width: 2400, height: 1500 })
// Dim, yellow-tinted pixels: each channel spans a narrow range and should be stretched to 0..255.
const dim = new Uint8ClampedArray(Array(50).fill([60, 50, 20, 255, 200, 180, 120, 255]).flat())
const enhanced = enhancePixels(Uint8ClampedArray.from(dim))
assert.deepEqual([...enhanced.slice(0, 8)], [0, 0, 0, 255, 255, 255, 255, 255])
// Half strength lands halfway between original and full stretch (60 → 0 becomes 30; 200 → 255 becomes 227.5).
const half = enhancePixels(Uint8ClampedArray.from(dim), 0.5)
assert.deepEqual([...half.slice(0, 8)], [30, 25, 10, 255, 228, 218, 188, 255])
// A flat channel (no contrast to stretch) is left alone.
const flat = enhancePixels(new Uint8ClampedArray([100, 100, 100, 255, 100, 100, 100, 255]))
assert.deepEqual([...flat], [100, 100, 100, 255, 100, 100, 100, 255])
// Transparent pixels (a black table around a cut-out) don't drag the levels: the sticker's own range is stretched.
const cutOut = new Uint8ClampedArray([...Array(50).fill([0, 0, 0, 0]).flat(), ...dim])
assert.deepEqual([...enhancePixels(cutOut).slice(200, 208)], [0, 0, 0, 255, 255, 255, 255, 255])
// Card outline 100,50 → 300,170 plus a fully outlined QR-code-sized square inside it; the card should win.
const onRectangle = (x, y, [left, top, right, bottom]) =>
  ((Math.abs(x - left) <= 1 || Math.abs(x - right) <= 1) && y >= top && y <= bottom) ||
  ((Math.abs(y - top) <= 1 || Math.abs(y - bottom) <= 1) && x >= left && x <= right)
const card = [100, 50, 300, 170]
const qrCode = [120, 70, 170, 120]
const isEdge = (x, y) => onRectangle(x, y, card) || onRectangle(x, y, qrCode)
const rectangleLines = ([left, top, right, bottom]) => [
  segmentToLine(left, top, right, top), segmentToLine(left, bottom, right, bottom),
  segmentToLine(left, top, left, bottom), segmentToLine(right, top, right, bottom),
]
const { quad } = findBestQuad([...rectangleLines(qrCode), ...rectangleLines(card)], isEdge, 400, 300)
assert.deepEqual(quad.map(({ x, y }) => [Math.round(x), Math.round(y)]), [[100, 50], [300, 50], [300, 170], [100, 170]])
// With business-card proportions required, a 3:1 strip is rejected even though its edges are perfect.
const strip = [100, 50, 130, 140]
assert.equal(findBestQuad(rectangleLines(strip), (x, y) => onRectangle(x, y, strip), 400, 300, [1.35, 1.95]), null)
assert.ok(findBestQuad(rectangleLines(strip), (x, y) => onRectangle(x, y, strip), 400, 300))
// Lines with no edges under them (e.g. a diagonal stroke in the artwork) never form a card.
assert.equal(findBestQuad(rectangleLines(card), () => false, 400, 300), null)
// Refinement: a white card on a dark background spanning x 100–300, y 50–170, detected 4px too large all round.
const cardPixel = (x, y) => (x >= 100 && x < 300 && y >= 50 && y < 170 ? [240, 240, 240] : [40, 30, 20])
const refined = refineQuad([{ x: 96, y: 46 }, { x: 304, y: 46 }, { x: 304, y: 174 }, { x: 96, y: 174 }], cardPixel, 8)
// Pixel edges fall at x.5 (e.g. 99.5 | 100); each side then sits 1px inside the card.
const expectedCorners = [[100.5, 50.5], [298.5, 50.5], [298.5, 168.5], [100.5, 168.5]]
refined.forEach((corner, i) => {
  const [x, y] = expectedCorners[i]
  assert.ok(Math.abs(corner.x - x) <= 0.25 && Math.abs(corner.y - y) <= 0.25, `corner ${JSON.stringify(corner)} should be near ${x},${y}`)
})
console.log('crop tests passed')
