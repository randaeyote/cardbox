import { useEffect } from 'preact/hooks'
import { registerSW } from 'virtual:pwa-register'
import { t } from './i18n.js'

// A new build waits until the user taps Refresh: an automatic reload could land mid-shoot. The bar stays hidden while
// there's unsaved work (shots in the camera, an edit in progress) and shows once that's done.
let unsavedWork = false
let bar = null

export function setUnsavedWork(value) {
  unsavedWork = value
  if (bar) bar.hidden = unsavedWork
}

// For a screen an update's reload would break, e.g. one showing a link already shared.
export function useUnsavedWork() {
  useEffect(() => {
    setUnsavedWork(true)
    return () => setUnsavedWork(false)
  }, [])
}

let registration = null
// Reloads the page, onto a waiting new build if there is one (a plain reload would keep the old one).
export function reloadApp() {
  reloadAsked = true
  if (registration?.waiting) updateServiceWorker()
  else location.reload()
}
// Set once Refresh is tapped. A new build taking over reloads the page only then: it can also take over because Refresh
// was tapped in another tab, and a reload then could land mid-shoot.
let reloadAsked = false
const CHECK_EVERY_MS = 10 * 60 * 1000
function showBar() {
  if (bar) return
  bar = document.createElement('button')
  bar.type = 'button'
  bar.className = 'update-bar glass'
  bar.textContent = `${t('New version available')} · ${t('Refresh')}`
  bar.hidden = unsavedWork
  // A waiting build takes over first; one that already took over by itself only needs the reload.
  bar.onclick = () => { bar.disabled = true; reloadApp() }
  document.body.append(bar)
}

const updateServiceWorker = registerSW({
  onNeedRefresh: showBar,
  onNeedReload: () => (reloadAsked ? location.reload() : showBar()),
  // The browser checks for a new build only when a page loads. iOS resumes a Home Screen app without loading it, and a
  // desktop tab left open is never reloaded, so check when the app comes back to the foreground or the window regains
  // focus, and every so often while it stays open.
  onRegisteredSW(url, found) {
    registration = found
    const check = () => found?.update().catch(() => {})
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check() })
    addEventListener('focus', check)
    setInterval(check, CHECK_EVERY_MS)
  },
})

// A build that takes over while this page is open (Refresh tapped in another tab) leaves it on the old code: offer the
// reload then too. Goes by whether a worker was installed when the page loaded, not whether it controlled the page: a
// hard refresh leaves the page uncontrolled. The very first install isn't an update.
const installedAtLoad = navigator.serviceWorker?.getRegistration().then((found) => !!found?.active).catch(() => false)
navigator.serviceWorker?.addEventListener('controllerchange', async () => {
  if (reloadAsked) location.reload()
  else if (await installedAtLoad) showBar()
})
