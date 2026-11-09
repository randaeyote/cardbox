import { t } from './i18n.js'

const MAX_OUTPUT_DIMENSION = 2400
const DETECTION_DIMENSION = 500
const MIN_AREA_FRACTION = 0.02

let openCvPromise
// Loaded as a plain script with a fixed URL (copied from node_modules by the prebuild/predev scripts) instead of
// bundled, so its filename doesn't change between builds and an open page never requests a deleted chunk.
export function loadOpenCv() {
  openCvPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/opencv.js'
    script.onload = resolve
    script.onerror = () => reject(new Error(t('Could not download /opencv.js')))
    document.head.append(script)
  }).then(async () => {
    const exported = globalThis.cv
    if (!exported) throw new Error(t('opencv.js loaded but did not define cv'))
    // Wrapped in an object because a thenable cv returned from an async function would be re-awaited.
    if (exported instanceof Promise) return { cv: await exported }
    if (!exported.Mat) await new Promise((resolve) => { exported.onRuntimeInitialized = resolve })
    return { cv: exported }
  }).then(({ cv }) => cv)
  openCvPromise.catch(() => { openCvPromise = undefined })
  return openCvPromise
}

export function orderCorners(points) {
  const by = (score) => points.reduce((best, point) => (score(point) < score(best) ? point : best))
  return [
    by((p) => p.x + p.y),
    by((p) => p.y - p.x),
    by((p) => -(p.x + p.y)),
    by((p) => p.x - p.y),
  ]
}

// Runs fn(track), where track(mat) returns the mat and frees it when fn finishes, however it finishes.
export function withMats(fn) {
  const mats = []
  try {
    return fn((mat) => (mats.push(mat), mat))
  } finally {
    mats.forEach((mat) => mat.delete())
  }
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

export function outputSize([topLeft, topRight, bottomRight, bottomLeft]) {
  let width = Math.max(distance(topLeft, topRight), distance(bottomLeft, bottomRight))
  let height = Math.max(distance(topLeft, bottomLeft), distance(topRight, bottomRight))
  const scale = Math.min(1, MAX_OUTPUT_DIMENSION / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

// Card edges are found as straight lines rather than closed outlines: fingers, artwork touching the border, and
// low contrast against skin all break an outline, but leave long straight runs. Edges come from all three Lab
// channels because a red card on a hand can be the same grey but a different colour.
export function detectCorners(cv, source) {
  const scale = Math.min(1, DETECTION_DIMENSION / Math.max(source.width, source.height))
  const small = scaledCanvas(source, DETECTION_DIMENSION)
  const { width, height } = small

  return withMats((track) => {
    const rgb = track(new cv.Mat())
    cv.cvtColor(track(cv.imread(small)), rgb, cv.COLOR_RGBA2RGB)
    const lab = track(new cv.Mat())
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab)
    const channels = track(new cv.MatVector())
    cv.split(lab, channels)
    const blurred = [0, 1, 2].map((index) => {
      const channel = track(new cv.Mat())
      cv.GaussianBlur(track(channels.get(index)), channel, new cv.Size(5, 5), 0)
      return channel
    })
    const findEdges = (thresholds) => {
      const edges = track(cv.Mat.zeros(height, width, cv.CV_8U))
      thresholds.forEach(([low, high], index) => {
        const channelEdges = track(new cv.Mat())
        cv.Canny(blurred[index], channelEdges, low, high)
        cv.bitwise_or(edges, channelEdges, edges)
      })
      return edges
    }
    const edges = findEdges(LINE_CANNY_THRESHOLDS)

    // Segments rank lines by their longest unbroken run, so a card's long edges outrank the many short strokes of
    // QR codes and text, which a whole-line vote count does not.
    const findLines = (edgeMap, minLengthFraction) => {
      const segments = track(new cv.Mat())
      cv.HoughLinesP(edgeMap, segments, 1, Math.PI / 180, 30, Math.min(width, height) * minLengthFraction, MAX_SEGMENT_GAP)
      const lines = []
      for (let i = 0; i < segments.data32S.length; i += 4) lines.push(segmentToLine(...segments.data32S.slice(i, i + 4)))
      return lines
    }
    const strongLines = findLines(edges, MIN_SEGMENT_FRACTION)

    // Fainter edges count when checking a side (a pale card border against a palm barely registers; using them
    // for line finding too would flood it with texture lines), but only where the edge runs along the side:
    // skin and print texture point every which way, a real card edge doesn't.
    const faintEdges = findEdges(SUPPORT_CANNY_THRESHOLDS)
    const support = faintEdges.data
    // Long straight runs of faint edge catch a card border that barely contrasts with what's behind it. They may
    // supply only one side of a card (see findBestQuad), or wood grain and shadows would form whole false cards.
    const faintLines = findLines(faintEdges, MIN_FAINT_SEGMENT_FRACTION)
    const gradientX = new Float32Array(width * height)
    const gradientY = new Float32Array(width * height)
    for (const channel of blurred) {
      const dx = track(new cv.Mat())
      const dy = track(new cv.Mat())
      cv.Sobel(channel, dx, cv.CV_32F, 1, 0)
      cv.Sobel(channel, dy, cv.CV_32F, 0, 1)
      const channelX = dx.data32F
      const channelY = dy.data32F
      // Keep, per pixel, the gradient of whichever channel changes most there.
      for (let i = 0; i < gradientX.length; i++) {
        if (channelX[i] ** 2 + channelY[i] ** 2 > gradientX[i] ** 2 + gradientY[i] ** 2) {
          gradientX[i] = channelX[i]
          gradientY[i] = channelY[i]
        }
      }
    }
    const isEdge = (x, y, normalX, normalY) => {
      // Search a couple of pixels either side, since the fitted line can sit slightly off the edge.
      for (let offset = -SUPPORT_SEARCH; offset <= SUPPORT_SEARCH; offset++) {
        const px = Math.round(x + normalX * offset)
        const py = Math.round(y + normalY * offset)
        if (px < 0 || py < 0 || px >= width || py >= height) continue
        const i = py * width + px
        if (!support[i]) continue
        const along = Math.abs(gradientX[i] * normalX + gradientY[i] * normalY)
        if (along >= MIN_GRADIENT_ALIGNMENT * Math.hypot(gradientX[i], gradientY[i])) return true
      }
      return false
    }

    const lines = [...strongLines, ...faintLines.map((line) => ({ ...line, faint: true }))]
    // Business-card proportions first; an unusual card (square, mini) still gets the unconstrained best.
    const found = findBestQuad(lines, isEdge, width, height, CARD_ASPECT_RANGE) ?? findBestQuad(lines, isEdge, width, height)
    if (!found) return null
    const quad = found.quad.map(({ x, y }) => ({ x: x / scale, y: y / scale }))
    return refineOnSource(source, quad, Math.ceil(REFINE_SEARCH_DETECTION_PIXELS / scale))
  })
}

const degrees = (value) => (value * Math.PI) / 180
// Per Lab channel: lightness, then the two colour axes.
const LINE_CANNY_THRESHOLDS = [[30, 90], [15, 45], [15, 45]]
const SUPPORT_CANNY_THRESHOLDS = [[15, 45], [8, 24], [8, 24]]
const SUPPORT_SEARCH = 2
// cos 25°: an edge pixel supports a side only if its gradient is within 25° of the side's normal.
const MIN_GRADIENT_ALIGNMENT = Math.cos(degrees(25))
// Shortest edge segment considered, as a fraction of the image's short side. Low enough for a card held at arm's length.
const MIN_SEGMENT_FRACTION = 0.1
// Pixels of gap bridged within one segment. Larger values chain dense artwork into long false diagonals that
// swallow the real edge; smaller ones break a far card's edges. Tuned on test-images at 50–100% scale.
const MAX_SEGMENT_GAP = 10
const MIN_FAINT_SEGMENT_FRACTION = 0.3
const MAX_LINES_PER_GROUP = 20
// Long side ÷ short side. ISO cards are 1.55, US 1.75, Japanese 1.65; the margin covers perspective, since the
// ratio is measured on the unwarped outline. Inner rectangles (QR codes, photos on the card) mostly fall outside.
const CARD_ASPECT_RANGE = [1.45, 1.85]
const MAX_FAINT_LINES_PER_GROUP = 8
const MIN_SIDE_SUPPORT = 0.45
// Rounded card corners don't reach the line intersections, so the ends of each side aren't checked.
const CORNER_SKIP = 0.08
// Perspective skews a card, but opposite edges stay roughly parallel and adjacent edges roughly square.
const MAX_PARALLEL_DEVIATION = degrees(20)
const MAX_SQUARE_DEVIATION = degrees(30)

// Normal form x·cos θ + y·sin θ = ρ, θ in [0, π). θ near 90° is a horizontal edge. strength ranks lines.
const normalizeLine = (rho, theta, strength) =>
  theta >= Math.PI ? { rho: -rho, theta: theta - Math.PI, strength } : { rho, theta, strength }

export function segmentToLine(x1, y1, x2, y2) {
  let theta = Math.atan2(x2 - x1, -(y2 - y1))
  if (theta < 0) theta += Math.PI
  return normalizeLine(x1 * Math.cos(theta) + y1 * Math.sin(theta), theta, Math.hypot(x2 - x1, y2 - y1))
}

const angleBetween = (a, b) => {
  const difference = Math.abs(a.theta - b.theta) % Math.PI
  return Math.min(difference, Math.PI - difference)
}

// Detection runs on a ~500px copy, so each edge can be off by several full-size pixels, which shows as a sliver of
// background along the crop. Re-locate every side on the full-size photo before warping.
function refineOnSource(source, quad, radius) {
  const margin = radius + 4
  const left = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.x)) - margin))
  const top = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.y)) - margin))
  const right = Math.min(source.width, Math.ceil(Math.max(...quad.map((p) => p.x)) + margin))
  const bottom = Math.min(source.height, Math.ceil(Math.max(...quad.map((p) => p.y)) + margin))
  const { data, width } = source.getContext('2d').getImageData(left, top, right - left, bottom - top)
  const regionHeight = bottom - top
  const pixelAt = (x, y) => {
    const px = Math.min(width - 1, Math.max(0, Math.round(x - left)))
    const py = Math.min(regionHeight - 1, Math.max(0, Math.round(y - top)))
    const i = (py * width + px) * 4
    return [data[i], data[i + 1], data[i + 2]]
  }
  return refineQuad(quad, pixelAt, radius)
}

const REFINE_SEARCH_DETECTION_PIXELS = 3
const REFINE_SAMPLES_PER_SIDE = 24
// Colour step (RGB distance) below which a sample has no usable edge and is skipped.
const REFINE_MIN_CONTRAST = 12
// Pixels to pull each side inward past the edge, so the crop's outermost pixels are card, not a blend with the
// background. The normal points inward because orderCorners lists corners clockwise on screen.
const REFINE_INSET = 1

// Moves each side of quad onto the strongest colour edge within `radius` pixels of it, sampled along the side
// and refitted as a straight line; corners are the new sides' intersections. pixelAt(x, y) returns [r, g, b].
export function refineQuad(quad, pixelAt, radius) {
  const sides = quad.map((from, index) => refineSide(from, quad[(index + 1) % 4], pixelAt, radius))
  return quad.map((corner, index) => {
    const moved = intersectRays(sides[(index + 3) % 4], sides[index])
    return moved && distance(moved, corner) <= radius * 2 ? moved : corner
  })
}

function refineSide(from, to, pixelAt, radius) {
  const length = distance(from, to)
  const direction = { x: (to.x - from.x) / length, y: (to.y - from.y) / length }
  const normal = { x: -direction.y, y: direction.x }
  const original = { point: from, direction }
  // Averaged across 3 pixels along the side to steady the profile against print and sensor noise.
  const colourAt = (base, offset) => {
    const total = [0, 0, 0]
    for (let along = -1; along <= 1; along++) {
      const [r, g, b] = pixelAt(base.x + normal.x * offset + direction.x * along, base.y + normal.y * offset + direction.y * along)
      total[0] += r; total[1] += g; total[2] += b
    }
    return total
  }
  const points = []
  for (let sample = 0; sample < REFINE_SAMPLES_PER_SIDE; sample++) {
    // Middle 70% only: the ends run into rounded corners.
    const t = 0.15 + (0.7 * sample) / (REFINE_SAMPLES_PER_SIDE - 1)
    const base = { x: from.x + direction.x * length * t, y: from.y + direction.y * length * t }
    const profile = []
    for (let offset = -radius - 2; offset <= radius + 2; offset++) profile.push(colourAt(base, offset))
    const steps = []
    for (let offset = -radius; offset <= radius; offset++) {
      const i = offset + radius + 2
      const before = profile[i - 2].map((value, channel) => value + profile[i - 1][channel])
      const after = profile[i + 1].map((value, channel) => value + profile[i + 2][channel])
      steps.push(Math.hypot(...after.map((value, channel) => value - before[channel])))
    }
    const best = steps.indexOf(Math.max(...steps))
    // Sums of 3 × 2 pixels per side, so the threshold scales by 6.
    if (steps[best] < REFINE_MIN_CONTRAST * 6) continue
    // Parabola through the peak and its neighbours puts the edge between whole pixels.
    const [left, middle, right] = [steps[best - 1] ?? steps[best], steps[best], steps[best + 1] ?? steps[best]]
    const curvature = left - 2 * middle + right
    const offset = best - radius + (curvature < 0 ? (left - right) / (2 * curvature) : 0) + REFINE_INSET
    points.push({ x: base.x + normal.x * offset, y: base.y + normal.y * offset })
  }
  if (points.length < REFINE_SAMPLES_PER_SIDE / 4) return original
  let fit = fitLine(points)
  // One pass of outlier rejection: samples that caught print or a finger instead of the card edge.
  const inliers = points.filter((point) => lineDistance(fit, point) <= 1.5)
  if (inliers.length >= REFINE_SAMPLES_PER_SIDE / 4) fit = fitLine(inliers)
  return fit
}

// Total least squares: the line through the centroid along the points' principal direction.
function fitLine(points) {
  const centre = { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length }
  let xx = 0, xy = 0, yy = 0
  for (const { x, y } of points) {
    xx += (x - centre.x) ** 2; xy += (x - centre.x) * (y - centre.y); yy += (y - centre.y) ** 2
  }
  const angle = Math.atan2(2 * xy, xx - yy) / 2
  return { point: centre, direction: { x: Math.cos(angle), y: Math.sin(angle) } }
}

const lineDistance = ({ point, direction }, p) => Math.abs((p.x - point.x) * direction.y - (p.y - point.y) * direction.x)

function intersectRays(a, b) {
  const cross = a.direction.x * b.direction.y - a.direction.y * b.direction.x
  if (Math.abs(cross) < 1e-9) return null
  const t = ((b.point.x - a.point.x) * b.direction.y - (b.point.y - a.point.y) * b.direction.x) / cross
  return { x: a.point.x + a.direction.x * t, y: a.point.y + a.direction.y * t }
}

function intersect(a, b) {
  const determinant = Math.cos(a.theta) * Math.sin(b.theta) - Math.sin(a.theta) * Math.cos(b.theta)
  if (Math.abs(determinant) < 1e-6) return null
  return {
    x: (a.rho * Math.sin(b.theta) - b.rho * Math.sin(a.theta)) / determinant,
    y: (Math.cos(a.theta) * b.rho - Math.cos(b.theta) * a.rho) / determinant,
  }
}

// The same edge is usually found several times at nearly the same angle and offset; keep the strongest.
function dedupeLines(lines) {
  const kept = []
  for (const line of [...lines].sort((a, b) => b.strength - a.strength)) {
    const duplicate = kept.some((other) => {
      let rhoDifference = Math.abs(other.rho - line.rho)
      // θ wraps at π, where the same line flips the sign of ρ.
      if (Math.abs(other.theta - line.theta) > Math.PI / 2) rhoDifference = Math.abs(other.rho + line.rho)
      return angleBetween(other, line) < degrees(6) && rhoDifference < 10
    })
    if (!duplicate) kept.push(line)
  }
  return kept
}

function sideSupport(from, to, isEdge) {
  const length = distance(from, to)
  const normalX = length ? -(to.y - from.y) / length : 0
  const normalY = length ? (to.x - from.x) / length : 0
  const steps = Math.max(1, Math.round(length / 2))
  let hits = 0
  let samples = 0
  for (let step = 0; step <= steps; step++) {
    const t = step / steps
    if (t < CORNER_SKIP || t > 1 - CORNER_SKIP) continue
    samples++
    if (isEdge(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, normalX, normalY)) hits++
  }
  return { fraction: samples ? hits / samples : 0, length }
}

// Tries every pair of near-horizontal with every pair of near-vertical lines and keeps the quad whose perimeter
// lies most on detected edges, so the card beats the QR codes and text blocks printed on it.
// ponytail: O(n⁴) over the 20 longest lines per orientation, pruned by perimeter; a card tilted near 45° may
// have its edges split across the groups.
export function findBestQuad(lines, isEdge, width, height, aspectRange = null) {
  // Faint and clear lines are deduplicated separately: the two versions of one edge can sit a few pixels apart, and
  // either may be the better fit, so both stay candidates.
  const unique = [...dedupeLines(lines.filter((line) => !line.faint)), ...dedupeLines(lines.filter((line) => line.faint))]
  const isHorizontal = (line) => Math.abs(line.theta - Math.PI / 2) < Math.PI / 4
  const strongest = (group) => [
    ...group.filter((line) => !line.faint).slice(0, MAX_LINES_PER_GROUP),
    ...group.filter((line) => line.faint).slice(0, MAX_FAINT_LINES_PER_GROUP),
  ]
  const horizontals = strongest(unique.filter(isHorizontal))
  const verticals = strongest(unique.filter((line) => !isHorizontal(line)))
  const margin = Math.min(width, height) * 0.02
  const inside = (point) => point && point.x > -margin && point.y > -margin && point.x < width + margin && point.y < height + margin
  const minimumArea = width * height * MIN_AREA_FRACTION
  const squareEnough = (a, b) => Math.abs(angleBetween(a, b) - Math.PI / 2) <= MAX_SQUARE_DEVIATION

  let best = null
  for (let i = 0; i < horizontals.length; i++) {
    for (let j = i + 1; j < horizontals.length; j++) {
      if (angleBetween(horizontals[i], horizontals[j]) > MAX_PARALLEL_DEVIATION) continue
      for (let k = 0; k < verticals.length; k++) {
        if (!squareEnough(horizontals[i], verticals[k])) continue
        for (let l = k + 1; l < verticals.length; l++) {
          if (angleBetween(verticals[k], verticals[l]) > MAX_PARALLEL_DEVIATION) continue
          if (!squareEnough(horizontals[j], verticals[l])) continue
          if ([horizontals[i], horizontals[j], verticals[k], verticals[l]].filter((line) => line.faint).length > 1) continue
          const points = [
            intersect(horizontals[i], verticals[k]), intersect(horizontals[i], verticals[l]),
            intersect(horizontals[j], verticals[l]), intersect(horizontals[j], verticals[k]),
          ]
          if (!points.every(inside)) continue
          const quad = orderCorners(points)
          if (polygonArea(quad) < minimumArea) continue
          if (aspectRange) {
            const { width: cardWidth, height: cardHeight } = outputSize(quad)
            const aspect = Math.max(cardWidth, cardHeight) / Math.min(cardWidth, cardHeight)
            if (aspect < aspectRange[0] || aspect > aspectRange[1]) continue
          }
          // A quad can score at most its perimeter, so skip the edge sampling when that can't beat the best.
          if (best && quad.reduce((sum, corner, n) => sum + distance(corner, quad[(n + 1) % 4]), 0) <= best.score) continue
          const sides = quad.map((corner, n) => sideSupport(corner, quad[(n + 1) % 4], isEdge))
          if (sides.some(({ fraction }) => fraction < MIN_SIDE_SUPPORT)) continue
          // Unsupported stretches count against, so a quad stretched past the card onto the hand loses.
          const score = sides.reduce((sum, { fraction, length }) => sum + (2 * fraction - 1) * length, 0)
          if (!best || score > best.score) best = { score, quad }
        }
      }
    }
  }
  return best
}

const polygonArea = (points) =>
  Math.abs(points.reduce((sum, point, n) => {
    const next = points[(n + 1) % points.length]
    return sum + point.x * next.y - next.x * point.y
  }, 0)) / 2

// Without corners the whole photo is used, only downscaled to the output cap.
export function warpCard(cv, source, corners) {
  if (!corners) return scaledCanvas(source, MAX_OUTPUT_DIMENSION)
  const { width, height } = outputSize(corners)
  return perspectiveWarp(cv, source, corners.flatMap(({ x, y }) => [x, y]), [0, 0, width, 0, width, height, 0, height], width, height, cv.BORDER_REPLICATE)
}

// Maps the quad `from` onto the quad `to` (each as 8 flat coordinates) in a width × height canvas. border: the
// remaining warpPerspective arguments, for what fills outside the source.
export function perspectiveWarp(cv, source, from, to, width, height, ...border) {
  const canvas = document.createElement('canvas')
  withMats((track) => {
    const input = track(cv.imread(source))
    const transform = track(cv.getPerspectiveTransform(track(cv.matFromArray(4, 1, cv.CV_32FC2, from)), track(cv.matFromArray(4, 1, cv.CV_32FC2, to))))
    const output = track(new cv.Mat())
    cv.warpPerspective(input, output, transform, new cv.Size(width, height), cv.INTER_LINEAR, ...border)
    cv.imshow(canvas, output)
  })
  return canvas
}

// Stretches each colour channel so its darkest 1% maps to black and brightest 1% to white. Doing it per channel
// also neutralises yellow venue lighting, since white card paper ends up white.
// ponytail: global levels only; switch to CLAHE (cv.CLAHE on the L channel) if uneven lighting/shadows matter.
// amount 0–1 blends between the original (0) and the full stretch (1).
// Transparent pixels (around a cut-out sticker) don't count towards the levels.
export function enhancePixels(data, amount = 1) {
  let pixelCount = 0
  for (let i = 3; i < data.length; i += 4) if (data[i]) pixelCount++
  for (let channel = 0; channel < 3; channel++) {
    const histogram = new Uint32Array(256)
    for (let i = channel; i < data.length; i += 4) if (data[i - channel + 3]) histogram[data[i]]++
    const percentile = (fraction) => {
      let total = 0
      for (let value = 0; value < 256; value++) {
        total += histogram[value]
        if (total >= pixelCount * fraction) return value
      }
      return 255
    }
    const low = percentile(0.01)
    const high = percentile(0.99)
    if (high - low < 16) continue
    const lookup = new Uint8ClampedArray(256)
    for (let value = 0; value < 256; value++) lookup[value] = value + (((value - low) * 255) / (high - low) - value) * amount
    for (let i = channel; i < data.length; i += 4) data[i] = lookup[data[i]]
  }
  return data
}

// Applied to new crops; the slider can change it afterwards.
const DEFAULT_ENHANCE = 0.5
export const DEFAULT_ADJUSTMENT = { rotation: 0, enhance: DEFAULT_ENHANCE }

// rotation is clockwise degrees: 0, 90, 180 or 270.
// enhance is a strength from 0 to 1; edits saved before the slider stored true/false, which Number() maps the same way.
export function adjustCard(canvas, { rotation, enhance }) {
  const strength = Number(enhance) || 0
  const sideways = rotation % 180 !== 0
  const output = document.createElement('canvas')
  output.width = sideways ? canvas.height : canvas.width
  output.height = sideways ? canvas.width : canvas.height
  const context = output.getContext('2d')
  context.translate(output.width / 2, output.height / 2)
  context.rotate((rotation * Math.PI) / 180)
  context.drawImage(canvas, -canvas.width / 2, -canvas.height / 2)
  if (strength > 0) {
    context.setTransform(1, 0, 0, 1, 0, 0)
    const pixels = context.getImageData(0, 0, output.width, output.height)
    enhancePixels(pixels.data, strength)
    context.putImageData(pixels, 0, 0)
  }
  return output
}

// Corners are measured on a small copy; the curve is a few dozen pixels even there.
const CORNER_DETECTION_DIMENSION = 400
// Rounder than this share of the short side is beyond any printed card; the search stops there.
const MAX_CORNER_FRACTION = 0.18
// How different (RGB distance) the background must be from the card's edge for a corner to be measured.
const MIN_CORNER_CONTRAST = 20

// How round a straight-cropped card's corners are, as a share of its width and height ({ x, y }, as in CSS's
// `border-radius: x% / y%`), or null where no corner shows the background (square corners, or a background the colour
// of the card's edge). A rounded card's crop shows the table in each corner, out to the curve; along the diagonal that
// patch reaches r·(1 − 1/√2) in from the corner, so its depth gives r. The median over the corners, so one corner over
// a busy background doesn't skew it.
export function measureCorners(canvas) {
  const small = scaledCanvas(canvas, CORNER_DETECTION_DIMENSION)
  const { width, height } = small
  const data = small.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data
  // A 3×3 average, so one noisy pixel doesn't end the patch early.
  const colourAt = (x, y) => {
    const sum = [0, 0, 0]
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const i = (Math.min(height - 1, Math.max(0, y + dy)) * width + Math.min(width - 1, Math.max(0, x + dx))) * 4
        for (let c = 0; c < 3; c++) sum[c] += data[i + c]
      }
    }
    return sum.map((value) => value / 9)
  }
  const apart = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  const far = Math.round(Math.min(width, height) * MAX_CORNER_FRACTION)
  const radii = []
  for (const [x, y, dx, dy] of [[0, 0, 1, 1], [width - 1, 0, -1, 1], [width - 1, height - 1, -1, -1], [0, height - 1, 1, -1]]) {
    const background = colourAt(x + dx, y + dy)
    // The card just inside each edge, past where any curve has ended.
    const edges = [colourAt(x + dx * far, y + dy * 2), colourAt(x + dx * 2, y + dy * far)]
    if (edges.some((edge) => apart(edge, background) < MIN_CORNER_CONTRAST)) continue
    let depth = 1
    const isBackground = (colour) => apart(colour, background) < Math.min(...edges.map((edge) => apart(colour, edge)))
    while (depth < far && isBackground(colourAt(x + dx * depth, y + dy * depth))) depth++
    radii.push(Math.min(far, depth / (1 - Math.SQRT1_2)))
  }
  if (radii.length < 2) return null
  radii.sort((a, b) => a - b)
  const radius = (radii[Math.floor((radii.length - 1) / 2)] + radii[Math.ceil((radii.length - 1) / 2)]) / 2
  return { x: radius / width, y: radius / height }
}

// Crops a photo with no editor step: detected corners if found, else the whole photo. `detected` flags which.
export async function autoCrop(cv, original) {
  const source = await decodeScaled(original)
  let corners = null
  try {
    corners = detectCorners(cv, source)
  } catch (error) {
    console.error('Edge detection failed', error)
  }
  const canvas = adjustCard(warpCard(cv, source, corners), DEFAULT_ADJUSTMENT)
  const image = await canvasToWebp(canvas)
  return { image, original, edit: { corners, ...DEFAULT_ADJUSTMENT, radius: corners ? measureCorners(canvas) : null }, detected: !!corners }
}

// Stickers are cut out at most this big: plenty for a die-cut sticker, and keeps the image (WebP or PNG, for the transparent
// background) to a couple of MB.
const STICKER_DIMENSION = 1600
// The outline is found on a small copy; GrabCut's cost grows with the pixel count.
const STICKER_DETECTION_DIMENSION = 640
const GRABCUT_ROUNDS = 5
const PREVIEW_GRABCUT_ROUNDS = 3
// The camera's sticker guide is a centred square of 75% of the photo's short side (.rapid-guide.square); GrabCut
// treats everything outside this slightly larger square as background.
const STICKER_SEARCH_FRACTION = 0.92
// A cut-out covering less or more than this share of the search square is a failed one (nothing found, or the whole
// background taken), and the photo falls back to a rectangle crop.
const STICKER_AREA_RANGE = [0.03, 0.95]
// ± this much random noise per colour channel (out of 255), see findStickerOutline.
const STICKER_NOISE = 6

// Where to look for a sticker in a width × height photo when no area was picked: the square around the camera guide.
export function defaultStickerArea({ width, height }) {
  const side = Math.min(width, height) * STICKER_SEARCH_FRACTION
  return { x: (width - side) / 2, y: (height - side) / 2, width: side, height: side }
}

// Cuts a sticker out along its own outline, with a transparent background: GrabCut separates it from the table,
// the biggest blob is kept and its holes filled (stickers have none), and the edge is smoothed and anti-aliased.
// area ({ x, y, width, height } in the original's pixels) is where the sticker is; everything outside it counts as
// background. Same result shape as autoCrop, with edit { area, rotation, enhance } so adjusting starts from it; falls
// back to autoCrop (detected false) when no sticker-sized outline is found. Enhance is measured on the sticker alone.
export async function cutOutSticker(cv, original, area = null) {
  const cut = await cutStickerCanvas(cv, original, area)
  if (!cut) return { ...(await autoCrop(cv, original)), detected: false }
  const image = await canvasToWebp(adjustCard(cut.canvas, DEFAULT_ADJUSTMENT), { transparent: true })
  return { image, original, edit: { area, ...DEFAULT_ADJUSTMENT }, detected: true }
}

// The cut-out before rotation and enhance: { canvas } with a transparent background and the box it came from in the
// original's pixels (to show it in place), or null if no outline was found. removed: brush strokes
// ([{ radius, points: [{ x, y }] }], original's pixels) over what must be background, such as the sticker's shadow.
// preview: fewer GrabCut rounds, for the live preview while the area is being adjusted; a slightly rougher edge.
export async function cutStickerCanvas(cv, original, area = null, removed = [], { preview = false } = {}) {
  const { full, small, originalWidth, originalHeight } = await stickerSources(original)
  const picked = area ?? defaultStickerArea({ width: originalWidth, height: originalHeight })
  const toFull = full.width / originalWidth
  const outline = (() => {
    try {
      const strokes = removed.map(({ radius, points }) => ({ radius: radius * toFull, points: points.map(({ x, y }) => ({ x: x * toFull, y: y * toFull })) }))
      return findStickerOutline(cv, full, small, { x: picked.x * toFull, y: picked.y * toFull, width: picked.width * toFull, height: picked.height * toFull }, strokes, preview ? PREVIEW_GRABCUT_ROUNDS : GRABCUT_ROUNDS)
    } catch (error) {
      console.error('Sticker cut-out failed', error)
      return null
    }
  })()
  if (!outline) return null
  const { mask, bounds } = outline
  const pixels = full.getContext('2d').getImageData(bounds.x, bounds.y, bounds.width, bounds.height)
  for (let i = 0; i < mask.length; i++) pixels.data[i * 4 + 3] = mask[i]
  const cut = document.createElement('canvas')
  cut.width = bounds.width
  cut.height = bounds.height
  cut.getContext('2d').putImageData(pixels, 0, 0)
  return { canvas: cut, box: { x: bounds.x / toFull, y: bounds.y / toFull, width: bounds.width / toFull, height: bounds.height / toFull } }
}

// The photo decoded and scaled once per original, not on every cut-out while its area is being adjusted.
const stickerSourceCache = new WeakMap()
function stickerSources(original) {
  if (!stickerSourceCache.has(original)) {
    stickerSourceCache.set(original, createImageBitmap(original).then((bitmap) => {
      const full = scaledCanvas(bitmap, STICKER_DIMENSION)
      const sources = { full, small: scaledCanvas(full, STICKER_DETECTION_DIMENSION), originalWidth: bitmap.width, originalHeight: bitmap.height }
      bitmap.close?.()
      return sources
    }))
  }
  return stickerSourceCache.get(original)
}

// area and removed are in `full`'s pixels; small is `full` scaled down for GrabCut. Returns { mask: alpha per pixel of
// bounds, bounds: the sticker's box in `full` with a little margin } or null.
function findStickerOutline(cv, full, small, area, removed, rounds) {
  return withMats((track) => {
    const rgba = track(cv.imread(small))
    const rgb = track(new cv.Mat())
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB)
    // A little noise on the copy GrabCut reads. On an evenly coloured table its background model is otherwise so
    // narrow that every slightly-off pixel along the sticker's edge (blur, JPEG) counts as sticker, leaving a fringe
    // of table round the cut-out.
    // (Mat.data builds a new array view on every read, so it's read once.)
    const colours = rgb.data
    // A Uint8Array wraps rather than clamps, hence the explicit limits.
    for (let i = 0; i < colours.length; i++) colours[i] = Math.max(0, Math.min(255, colours[i] + (Math.random() - 0.5) * 2 * STICKER_NOISE))
    const toSmall = small.width / full.width
    // GrabCut needs at least a pixel of background outside the area.
    const left = Math.max(1, Math.round(area.x * toSmall))
    const top = Math.max(1, Math.round(area.y * toSmall))
    const right = Math.min(small.width - 1, Math.round((area.x + area.width) * toSmall))
    const bottom = Math.min(small.height - 1, Math.round((area.y + area.height) * toSmall))
    const rect = new cv.Rect(left, top, right - left, bottom - top)
    // Labels: 0 background, 1 foreground, 2 probably background, 3 probably foreground. Seeded as GC_INIT_WITH_RECT
    // would (inside the area probably foreground, the rest background), plus the brushed strokes as sure background.
    const labels = track(cv.Mat.zeros(small.height, small.width, cv.CV_8UC1))
    track(labels.roi(rect)).setTo(new cv.Scalar(cv.GC_PR_FGD))
    for (const { radius, points } of removed) {
      const thickness = Math.max(1, Math.round(radius * 2 * toSmall))
      const at = ({ x, y }) => new cv.Point(Math.round(x * toSmall), Math.round(y * toSmall))
      points.forEach((point, i) => cv.line(labels, at(points[i - 1] ?? point), at(point), new cv.Scalar(cv.GC_BGD), thickness))
    }
    cv.grabCut(rgb, labels, rect, track(new cv.Mat()), track(new cv.Mat()), rounds, cv.GC_INIT_WITH_MASK)
    const foreground = track(new cv.Mat(labels.rows, labels.cols, cv.CV_8UC1))
    const labelled = labels.data
    const kept = foreground.data
    for (let i = 0; i < labelled.length; i++) kept[i] = labelled[i] & 1 ? 255 : 0
    const kernel = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)))
    cv.morphologyEx(foreground, foreground, cv.MORPH_OPEN, kernel)
    cv.morphologyEx(foreground, foreground, cv.MORPH_CLOSE, kernel)

    const contours = new cv.MatVector()
    const hierarchy = track(new cv.Mat())
    try {
      cv.findContours(foreground, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
      let largest = -1
      let largestArea = 0
      for (let i = 0; i < contours.size(); i++) {
        const area = cv.contourArea(contours.get(i))
        if (area > largestArea) { largest = i; largestArea = area }
      }
      const share = largestArea / (rect.width * rect.height)
      if (largest < 0 || share < STICKER_AREA_RANGE[0] || share > STICKER_AREA_RANGE[1]) return null
      const filled = track(cv.Mat.zeros(foreground.rows, foreground.cols, cv.CV_8UC1))
      cv.drawContours(filled, contours, largest, new cv.Scalar(255), cv.FILLED)
      const box = cv.boundingRect(contours.get(largest))

      // Scale the outline up, then blur and re-threshold so the small copy's staircase becomes a smooth curve, and
      // blur once more lightly to anti-alias the edge.
      const scale = full.width / small.width
      const mask = track(new cv.Mat())
      cv.resize(filled, mask, new cv.Size(full.width, full.height), 0, 0, cv.INTER_LINEAR)
      const smoothing = 2 * Math.round(scale * 1.5) + 1
      cv.GaussianBlur(mask, mask, new cv.Size(smoothing, smoothing), 0)
      cv.threshold(mask, mask, 127, 255, cv.THRESH_BINARY)
      cv.GaussianBlur(mask, mask, new cv.Size(3, 3), 0)

      const margin = Math.round(Math.max(box.width, box.height) * scale * 0.02)
      const x = Math.max(0, Math.floor(box.x * scale) - margin)
      const y = Math.max(0, Math.floor(box.y * scale) - margin)
      const bounds = {
        x, y,
        width: Math.min(full.width, Math.ceil((box.x + box.width) * scale) + margin) - x,
        height: Math.min(full.height, Math.ceil((box.y + box.height) * scale) + margin) - y,
      }
      const all = mask.data
      const region = new Uint8ClampedArray(bounds.width * bounds.height)
      for (let row = 0; row < bounds.height; row++) {
        const start = (bounds.y + row) * full.width + bounds.x
        region.set(all.subarray(start, start + bounds.width), row * bounds.width)
      }
      return { mask: region, bounds }
    } finally {
      contours.delete()
    }
  })
}

const encode = (canvas, type, quality) =>
  new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t('Image encoding failed')))), type, quality),
  )
export const canvasToJpeg = (canvas, quality = 0.9) => encode(canvas, 'image/jpeg', quality)
// Keeps transparency, for cut-out stickers.
const canvasToPng = (canvas) => encode(canvas, 'image/png')

// Stored photos are WebP at this quality: on card photos it looks the same as the JPEGs it replaced at about a
// quarter of the size.
const WEBP_QUALITY = 0.85
let nativeWebp
const canEncodeWebp = () => (nativeWebp ??= new Promise((resolve) => {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  canvas.toBlob((blob) => resolve(blob?.type === 'image/webp'), 'image/webp')
}))

let webpWorker = null
const webpJobs = new Map()
let nextWebpJob = 0
function encodeInWorker(canvas, quality) {
  if (!webpWorker) {
    webpWorker = new Worker(new URL('./webp.worker.js', import.meta.url), { type: 'module' })
    webpWorker.onmessage = ({ data: { job, bytes, error } }) => {
      const { resolve, reject } = webpJobs.get(job)
      webpJobs.delete(job)
      if (error) reject(new Error(error))
      else resolve(new Blob([bytes], { type: 'image/webp' }))
    }
    // The worker itself failed to load: fail what's waiting, and try a fresh worker next time.
    webpWorker.onerror = (event) => {
      for (const { reject } of webpJobs.values()) reject(new Error(event.message || 'WebP worker failed'))
      webpJobs.clear()
      webpWorker = null
    }
  }
  const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
  const job = nextWebpJob++
  return new Promise((resolve, reject) => {
    webpJobs.set(job, { resolve, reject })
    webpWorker.postMessage({ job, buffer: data.buffer, width, height, quality: quality * 100 }, [data.buffer])
  })
}

// WebP, transparency included. Safari (every iPhone browser) can't encode WebP, so there libwebp compiled to
// WebAssembly does, in a worker so the camera doesn't stall. Falls back to JPEG (PNG when `transparent`) if even that
// fails, e.g. offline before the encoder was ever fetched.
export async function canvasToWebp(canvas, { quality = WEBP_QUALITY, transparent = false } = {}) {
  if (await canEncodeWebp()) return encode(canvas, 'image/webp', quality)
  try {
    return await encodeInWorker(canvas, quality)
  } catch (error) {
    console.warn('WebP encoding failed', error)
    return transparent ? canvasToPng(canvas) : canvasToJpeg(canvas)
  }
}

// Decodes a Blob (options: createImageBitmap's) into a canvas no larger than max, freeing the bitmap.
export async function decodeScaled(blob, max, options) {
  const bitmap = await createImageBitmap(blob, options)
  const canvas = scaledCanvas(bitmap, max)
  bitmap.close?.()
  return canvas
}

// source: anything drawable with a width and height. Only ever shrinks.
export function scaledCanvas(source, max = Infinity) {
  const scale = Math.min(1, max / Math.max(source.width, source.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(source.width * scale)
  canvas.height = Math.round(source.height * scale)
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}
