import encode from '@jsquash/webp/encode.js'

// Encodes WebP with libwebp (WebAssembly) off the main thread, for browsers that can't do it themselves (Safari).
self.onmessage = async ({ data: { job, buffer, width, height, quality } }) => {
  try {
    const bytes = await encode(new ImageData(new Uint8ClampedArray(buffer), width, height), { quality })
    self.postMessage({ job, bytes }, [bytes])
  } catch (error) {
    self.postMessage({ job, error: error.message })
  }
}
