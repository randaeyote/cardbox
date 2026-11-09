import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import zhHant from './zh-Hant.js'

// Every t('…') call must use a plain single-quoted literal with a Chinese entry, or that text would show in English.
const directory = new URL('.', import.meta.url)
const keys = new Set()
for (const file of readdirSync(directory).filter((name) => /\.jsx?$/.test(name) && !name.includes('.test.') && !['i18n.js', 'zh-Hant.js'].includes(name))) {
  const source = readFileSync(new URL(file, directory), 'utf8')
  for (const [, key] of source.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) keys.add(key.replace(/\\'/g, "'"))
  for (const [, one, many] of source.matchAll(/\btn\(\s*[\w.]+,\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'/g)) for (const key of [one, many]) keys.add(key.replace(/\\'/g, "'"))
  assert.ok(!/\bt\((?!')/.test(source.replace(/\bt\('(?:[^'\\]|\\.)*'/g, '')), `${file}: t() must be called with a string literal`)
}
const missing = [...keys].filter((key) => !(key in zhHant))
assert.deepEqual(missing, [], `missing Chinese for: ${missing.join(' | ')}`)
const unused = Object.keys(zhHant).filter((key) => !keys.has(key))
assert.deepEqual(unused, [], `unused Chinese entries: ${unused.join(' | ')}`)
console.log(`i18n tests passed (${keys.size} strings)`)
