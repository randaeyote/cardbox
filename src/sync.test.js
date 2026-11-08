import assert from 'node:assert/strict'
import { planSync, parsePairing, parseSyncLink, parseReceiveLink, pairingProof, mergeTied, contentOf } from './sync.js'

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
console.log('sync tests passed')
