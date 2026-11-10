# Cardbox

整理收藏卡片和貼紙的小工具：拍照自動裁切、分合集、做拼貼、傳給朋友。免安裝，資料只存在自己的手機。

A PWA for photos of collectible cards and stickers. Everything stays on the device (IndexedDB); no account, no server storage.

- **Capture:** shoot cards front then back; edges are found and cropped automatically (OpenCV). Stickers are cut out.
- **Organise:** names, collections, social links (scan a QR on the card), notes. Flick a card to turn it over.
- **Collage:** a collection as one shareable image.
- **Share:** send cards as a QR stream (offline) or as a pack over the network.
- **Sync:** pair two devices; cards go directly over WebRTC (PeerJS), via a TURN relay only when needed.
- **Backup:** zip export and import.
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
| `src/rapid.jsx` | Camera and review for capturing a stack of cards or stickers |
| `src/card3d.jsx` | The card that turns over in 3D |
| `src/crop.js`, `src/cropper.jsx` | Edge detection, perspective crop, and the manual crop editor |
| `src/db.js` | Card storage in IndexedDB |
| `src/sync.js`, `src/sync.jsx` | Device-to-device sync |
| `src/beam.js`, `src/beam.jsx`, `src/pack.jsx` | Sending cards: QR stream, network packs, and the pack opening |
| `src/backup.js` | Zip export and import |
| `src/collage.js` | Collage layout and drawing |
| `src/qr.js` | QR scanning |
| `src/i18n.js`, `src/zh-Hant.js` | Translations; strings are keyed by their English text |
| `src/ui.jsx` | Shared components |
| `worker/index.js` | Cloudflare Worker: serves the app, and short-lived TURN relay passwords at `/turn` |

`test-images/` holds the sample photos the edge-detection thresholds were tuned on.
