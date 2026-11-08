// Something typed or scanned that names a web page, with or without its https://.
const ADDRESS = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i

// What to show for a stored social: { text, href }. Web addresses become links shown without "https://www." or a
// trailing slash; anything else (a handle, a name) is plain text with href null.
export function describeSocial(social) {
  const value = social.trim()
  if (value.startsWith('@') || !ADDRESS.test(value)) return { text: value, href: null }
  const href = /^https?:\/\//i.test(value) ? value : `https://${value}`
  return { text: href.replace(/^https?:\/\/(www\.|m\.)?/i, '').replace(/\/$/, ''), href }
}
