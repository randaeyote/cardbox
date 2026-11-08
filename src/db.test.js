import assert from 'node:assert/strict'
import { migrateCard, compareInGroup } from './db.js'

const current = { id: '1', name: 'Ada', socials: ['@ada'], collections: ['DevConf'], orders: {}, note: '' }
assert.equal(migrateCard(current), current)
assert.deepEqual(
  migrateCard({ id: '3', socials: [], event: 'DevConf', order: 2, note: '' }),
  { id: '3', socials: [], collections: ['DevConf'], orders: { DevConf: 2 }, note: '' },
)
assert.deepEqual(migrateCard({ id: '4', socials: [], event: '', order: 0, note: '' }).orders, { '': 0 })

assert.deepEqual(
  migrateCard({ id: '2', name: 'Bob', title: 'CTO', company: '', email: 'bob@example.com', phone: '', website: '', event: '', note: 'met at lunch' }),
  { id: '2', name: 'Bob', socials: [], collections: [], orders: {}, note: 'met at lunch\nTitle: CTO\nEmail: bob@example.com' },
)
// 'other' is placed in another collection only, so here it counts as never dragged.
const unordered = [{ id: 'old', createdAt: '2026-01-01' }, { id: 'new', createdAt: '2026-02-01' }, { id: 'other', orders: { B: 0 }, createdAt: '2026-01-15' }]
const ordered = [{ id: 'second', orders: { A: 1 }, createdAt: '2026-03-01' }, { id: 'first', orders: { A: 0 }, createdAt: '2025-01-01' }]
assert.deepEqual([...ordered, ...unordered].sort(compareInGroup('A')).map((card) => card.id), ['new', 'other', 'old', 'first', 'second'])
console.log('db tests passed')
