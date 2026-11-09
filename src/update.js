import { useEffect } from 'preact/hooks'

// The service worker activates a new build at once, but the open page runs the old code until it reloads, so it
// reloads as soon as an update takes over: unless there's unsaved work (shots in the camera, an edit in progress),
// in which case it waits until that's done. The first install has no previous controller and must not reload.
let unsavedWork = false
let waiting = false

export function setUnsavedWork(value) {
  unsavedWork = value
  if (!unsavedWork && waiting) location.reload()
}

// For a screen an update's reload would break, e.g. one showing a link already shared.
export function useUnsavedWork() {
  useEffect(() => {
    setUnsavedWork(true)
    return () => setUnsavedWork(false)
  }, [])
}

if (navigator.serviceWorker?.controller) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (unsavedWork) waiting = true
    else location.reload()
  })
  // The browser checks for a new build only when a page loads, and iOS resumes a Home Screen app without loading it,
  // so check each time the app comes back to the foreground too.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') navigator.serviceWorker.getRegistration().then((registration) => registration?.update()).catch(() => {})
  })
}
