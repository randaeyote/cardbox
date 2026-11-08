import assert from 'node:assert/strict'
import { joinParts, splitParts, frameStream, frameCollector, blocksFor, BLOCK_BYTES } from './beam.js'

const photo = Uint8Array.from({ length: 2500 }, (_, i) => i % 251)
const packed = joinParts({ card: { id: 'a', name: '小明' } }, [{ name: 'front', type: 'image/jpeg', bytes: photo }])
const { card, parts } = splitParts(packed)
assert.deepEqual(card, { id: 'a', name: '小明' })
assert.deepEqual([...parts.front.bytes], [...photo])

// Mixes pick distinct blocks, the same ones for the same seed.
assert.deepEqual(blocksFor(3, 10), [3])
assert.deepEqual(blocksFor(1234, 50), blocksFor(1234, 50))
assert.equal(new Set(blocksFor(1234, 50)).size, blocksFor(1234, 50).length)

// Seeded so a failure reproduces.
let state = 42
const chance = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)

// A camera catching only some frames still rebuilds the card from a few more frames than it has blocks, and frames
// from another beam are ignored.
const big = Uint8Array.from({ length: 80_000 }, () => Math.floor(chance() * 256))
for (const missRate of [0, 0.3, 0.6]) {
  const stream = frameStream(big)
  const collector = frameCollector()
  const stranger = frameStream(new Uint8Array(3000)).next()
  let caught = 0
  for (let shown = 0; !collector.done; shown++) {
    assert.ok(shown < stream.count * 20, `stuck at miss rate ${missRate}`)
    const frame = stream.next()
    if (chance() < missRate) continue
    caught++
    collector.add(frame)
    if (caught === 5 && stranger[2] * 256 + stranger[3] !== frame[2] * 256 + frame[3]) assert.equal(collector.add(stranger), false)
  }
  assert.deepEqual(collector.bytes(), big)
  // Caught frames needed: the block count, plus a few at most.
  const overhead = caught / stream.count
  assert.ok(caught <= stream.count + 5, `needed ${overhead.toFixed(2)}× the blocks at miss rate ${missRate}`)
  console.log(`  miss ${missRate * 100}%: ${stream.count} blocks, ${caught} frames caught (${overhead.toFixed(2)}×)`)
}
assert.equal(frameCollector().add(new Uint8Array(20)), false)
assert.equal(BLOCK_BYTES, 800)
console.log('beam tests passed')
