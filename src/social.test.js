import assert from 'node:assert/strict'
import { describeSocial } from './social.js'

const cases = [
  ['https://x.com/YuuYuuMagician', { text: 'x.com/YuuYuuMagician', href: 'https://x.com/YuuYuuMagician' }],
  ['https://www.facebook.com/ruishuowo/', { text: 'facebook.com/ruishuowo', href: 'https://www.facebook.com/ruishuowo/' }],
  ['linktr.ee/kaltespur', { text: 'linktr.ee/kaltespur', href: 'https://linktr.ee/kaltespur' }],
  ['@AnyaoOkami', { text: '@AnyaoOkami', href: null }],
  ['羽下犬太', { text: '羽下犬太', href: null }],
]
for (const [input, expected] of cases) assert.deepEqual(describeSocial(input), expected, input)
console.log('social tests passed')
