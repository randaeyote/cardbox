import zhHant from './zh-Hant.js'

const STORAGE_KEY = 'language'
const DEFAULT_LANGUAGE = 'zh-Hant'
// Each language's own name, shown on the switch.
export const LANGUAGES = { 'zh-Hant': '中文', en: 'English' }

function readLanguage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved in LANGUAGES ? saved : DEFAULT_LANGUAGE
  } catch {
    return DEFAULT_LANGUAGE
  }
}

export const language = readLanguage()
if (typeof document !== 'undefined') document.documentElement.lang = language

// Keys are the English text itself, so English needs no table and a missing translation falls back to English.
// `{name}` placeholders are filled from values.
export function t(text, values) {
  const template = (language === 'zh-Hant' && zhHant[text]) || text
  return values ? template.replace(/\{(\w+)\}/g, (_, name) => values[name]) : template
}

// A reload re-renders every string; the switches live in the Settings drawer and the empty list, where nothing is
// mid-edit.
export function setLanguage(next) {
  localStorage.setItem(STORAGE_KEY, next)
  location.reload()
}
