import preact from '@preact/preset-vite'
import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import openCvPackage from '@techstark/opencv-js/package.json' with { type: 'json' }

export default defineConfig({
  preview: { allowedHosts: ['.ts.net'] },
  // Pre-bundling would move the encoder away from the .wasm files it finds next to itself (new URL(…, import.meta.url)).
  optimizeDeps: { exclude: ['@jsquash/webp'] },
  // The WebP worker loads its encoder with a dynamic import, which classic (non-module) workers can't do.
  worker: { format: 'es' },
  define: {
    BUILD_TIME: JSON.stringify(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' GMT+8'),
    // Cloudflare answers a HEAD without Content-Length, so the demo download's size is taken from the file here.
    DEMO_BYTES: statSync('public/demo.zip').size,
    // Changes whenever the demo pack does, so a phone that has the current one can open it again without downloading.
    DEMO_VERSION: JSON.stringify(createHash('sha256').update(readFileSync('public/demo.zip')).digest('hex').slice(0, 16)),
  },
  plugins: [
    preact(),
    VitePWA({
      registerType: 'prompt',
      workbox: {
        // .wasm too: the QR reader and WebP encoder, so scanning, beaming and saving photos work offline.
        globPatterns: ['**/*.{js,css,html,wasm}'],
        globIgnores: ['opencv.js'],
        runtimeCaching: [{
          urlPattern: /\/opencv\.js$/,
          handler: 'CacheFirst',
          options: {
            // The URL is fixed, so a new OpenCV version needs a new cache name to replace the cached copy.
            cacheName: `opencv-${openCvPackage.version}`,
            cacheableResponse: { statuses: [200] },
          },
        }],
      },
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Cardbox',
        short_name: 'Cardbox',
        description: 'Local business card storage',
        display: 'standalone',
        // Installed on Android, the app stays upright; iOS ignores this, so there Rotation Lock decides.
        orientation: 'portrait',
        start_url: '/',
        background_color: '#f6f6f4',
        theme_color: '#2f5d8a',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
})
