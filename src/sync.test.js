import assert from 'node:assert/strict'
import { planSync, planDeletes, packIds, PACK_SIZE, parsePairing, parseSyncLink, parseReceiveLink, pairingProof, mergeTied, contentOf, keepOriginals, planOriginals } from './sync.js'

// cards: { id: time } or { id: [time, content] }, for brevity.
const state = (cards = {}) => Object.fromEntries(Object.entries(cards).map(([id, value]) => {
  const [time, content = 'same'] = [].concat(value)
  return [id, { time, content }]
}))
const fetched = (local, remote) => planSync(local, remote).sort()

// New on the other device: fetch it. Same on both: nothing.
assert.deepEqual(fetched(state({ a: '1' }), state({ a: '1', b: '1' })), ['b'])
// Edited more recently there: fetch; more recently here: keep ours (the other side fetches it).
assert.deepEqual(fetched(state({ a: '1', b: '3' }), state({ a: '2', b: '2' })), ['a'])
// Same time, different content (edited before edit times existed): fetch, and the other side fetches ours.
assert.deepEqual(fetched(state({ a: ['1', 'x'] }), state({ a: ['1', 'y'] })), ['a'])
assert.deepEqual(fetched(state({ a: ['1', 'y'] }), state({ a: ['1', 'x'] })), ['a'])
// Deleted here after its last edit there: not fetched back. Edited there after the delete: fetched.
assert.deepEqual(planSync(state({}), state({ a: '1', b: '3' }), { a: '2', b: '2' }), ['b'])
// Deleted there after its last edit here: offered for deleting. Edited here since: kept (the other side fetches it).
assert.deepEqual(planDeletes(state({ a: '1', b: '3' }), { a: '2', b: '2', c: '2' }), ['a'])
// A pack: eight different cards when there are enough; every card at least once, plus repeats, when there aren't.
{
  const many = Array.from({ length: 20 }, (_, i) => `c${i}`)
  const picked = packIds(many)
  assert.equal(picked.length, PACK_SIZE)
  assert.equal(new Set(picked).size, PACK_SIZE)
  const few = packIds(['a', 'b', 'c'])
  assert.equal(few.length, PACK_SIZE)
  assert.deepEqual([...new Set(few)].sort(), ['a', 'b', 'c'])
}
// A wiped device gets everything back.
assert.deepEqual(fetched(state({}), state({ a: '1', b: '2' })), ['a', 'b'])

// Tied copies merge to the same card whichever side does it, keeping every social and the filled-in fields.
const phone = { id: 'a', createdAt: '1', name: '', socials: ['x.com/a'], collections: ['Con'], note: '', front: { size: 10 } }
const mac = { id: 'a', createdAt: '1', name: 'Ada', socials: ['fb.com/a', 'x.com/a'], collections: ['Expo'], note: 'met', front: { size: 10 } }
const merged = mergeTied(phone, mac)
assert.deepEqual(merged, mergeTied(mac, phone))
assert.deepEqual([merged.name, merged.collections, merged.note, merged.socials], ['Ada', ['Con', 'Expo'], 'met', ['fb.com/a', 'x.com/a']])
// Merging again with either original changes nothing, so a second sync settles.
assert.equal(contentOf(mergeTied(merged, phone)), contentOf(merged))
assert.equal(contentOf(mergeTied(mac, merged)), contentOf(merged))

const secret = 'abcdefghij_-KLMNOPQRST'
assert.deepEqual(parseSyncLink(`https://example.com/app/#sync/K7Q29M.${secret}`), { code: 'K7Q29M', secret })
assert.deepEqual(parsePairing(`K7Q29M.${secret}`), { code: 'K7Q29M', secret })
assert.equal(parseSyncLink(`https://example.com/app/#receive/K7Q29M.${secret}`), null)
assert.ok(parseReceiveLink(`https://example.com/app/#receive/K7Q29M.${secret}`))
assert.equal(parsePairing('K7Q29M'), null)
assert.equal(parsePairing(`K0Q29M.${secret}`), null)

// Each side checks the other's proof against the fingerprints it sees, swapped, and the other's role.
const hostProof = await pairingProof(secret, 'host', 'host-print', 'guest-print')
assert.equal(hostProof, await pairingProof(secret, 'host', 'host-print', 'guest-print'))
assert.notEqual(hostProof, await pairingProof('wrong-secret-0123456789', 'host', 'host-print', 'guest-print'))
// A relay in the middle: the guest sees the relay's fingerprint, not the host's.
assert.notEqual(hostProof, await pairingProof(secret, 'host', 'relay-print', 'guest-print'))
// Bounced back to the host, which expects a guest's proof over the same two fingerprints.
assert.notEqual(hostProof, await pairingProof(secret, 'guest', 'guest-print', 'host-print'))
// A received card without originals keeps the ones here: with their crop details while the cropped photo is the same,
// with only the corner radius once it's different; and a card that brings its own originals keeps those.
{
  const photo = (size) => ({ size })
  const ours = { id: 'k', front: photo(10), frontOriginal: photo(99), frontEdit: { corners: [1], radius: 0.1 }, back: photo(20), backOriginal: photo(88), backEdit: { corners: [2], radius: 0.2 } }
  const received = { id: 'k', name: 'New', front: photo(10), frontOriginal: null, frontEdit: { radius: 0.1 }, back: photo(21), backOriginal: null, backEdit: { rotation: 90, radius: 0.3 } }
  const kept = keepOriginals(received, ours)
  assert.equal(kept.name, 'New')
  assert.equal(kept.frontOriginal, ours.frontOriginal)
  assert.deepEqual(kept.frontEdit, ours.frontEdit)
  assert.equal(kept.backOriginal, ours.backOriginal)
  assert.deepEqual(kept.backEdit, { radius: 0.3 })
  const own = { ...received, frontOriginal: photo(77) }
  assert.equal(keepOriginals(own, ours).frontOriginal, own.frontOriginal)
  assert.equal(keepOriginals(received, undefined), received)
}

// Listed for review: cards here with originals the other device has without; not a device that doesn't say.
assert.deepEqual(planOriginals(
  { a: { originals: true }, b: { originals: true }, c: { originals: false }, d: { originals: true } },
  { a: { originals: false }, b: { originals: true }, c: { originals: false }, d: {}, e: { originals: false } },
), ['a'])

console.log('sync tests passed')
