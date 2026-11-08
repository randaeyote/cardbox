# Cardbox

A PWA for keeping photos of business cards. Cards stay on the device (IndexedDB); there is no server or account.

- **Capture:** shoot a stack of cards in a row, front then back. Edges are found and cropped automatically (OpenCV), and you can adjust any crop by hand.
- **Organise:** name, collection, social links and notes per card. Social links can be filled in by scanning a QR code on the card.
- **Collage:** lay out a collection as one shareable image.
- **Sync:** pair two devices with a one-time code or QR. Cards go directly between them over WebRTC (PeerJS); the relay only connects them. Choose "Add only" or a full two-way sync.
- **Backup:** export and import a zip of all cards and photos.
- English and Traditional Chinese.

## Development

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run build && npm run preview
```

`predev` and `prebuild` copy `opencv.js` into `public/`. It's loaded lazily, and the service worker caches it separately from the app.

Camera access needs HTTPS or localhost. To try it on a phone, serve the preview over HTTPS, e.g. `tailscale serve`; `.ts.net` hosts are allowed in `vite.config.js`.

## Layout

| File | What it does |
| --- | --- |
| `src/app.jsx` | Screens and routing (hash based: `#card/<id>`, `#rapid`, `#group`, `#settings`, `#sync`) |
| `src/rapid.jsx` | Camera and review for capturing a stack of cards |
| `src/crop.js`, `src/cropper.jsx` | Edge detection, perspective crop, and the manual crop editor |
| `src/db.js` | Card storage in IndexedDB |
| `src/sync.js`, `src/sync.jsx` | Device-to-device sync |
| `src/backup.js` | Zip export and import |
| `src/collage.js` | Collage layout and drawing |
| `src/qr.js` | QR scanning |
| `src/i18n.js`, `src/zh-Hant.js` | Translations; strings are keyed by their English text |
| `src/ui.jsx` | Shared components |

`test-images/` holds the sample photos the edge-detection thresholds were tuned on.
