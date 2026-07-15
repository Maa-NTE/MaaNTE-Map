import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const DATA_FILE = process.env.MAANTE_MAP_DATA_FILE
  ? path.resolve(process.env.MAANTE_MAP_DATA_FILE)
  : fileURLToPath(new URL('./src/data/map-data.json', import.meta.url))
const UPLOADS_DIR = process.env.MAANTE_UPLOADS_DIR
  ? path.resolve(process.env.MAANTE_UPLOADS_DIR)
  : fileURLToPath(new URL('./public/images/uploads', import.meta.url))
const LOCATION_IMAGES_DIR = process.env.MAANTE_LOCATION_IMAGES_DIR
  ? path.resolve(process.env.MAANTE_LOCATION_IMAGES_DIR)
  : fileURLToPath(new URL('./public/images/locations', import.meta.url))
const MAX_LOCATION_IMAGE_BYTES = 10 * 1024 * 1024
const LOCATION_IMAGE_PATH_PATTERN = /^\/images\/locations\/([a-z0-9_-]{1,80})\/([a-f0-9]{64})\.(png|jpg|webp|gif)$/

const LOCATION_IMAGE_FORMATS = {
  gif: { extension: 'gif', mimeType: 'image/gif' },
  jpg: { extension: 'jpg', mimeType: 'image/jpeg' },
  png: { extension: 'png', mimeType: 'image/png' },
  webp: { extension: 'webp', mimeType: 'image/webp' },
}

function sendJson(response, payload, statusCode = 200) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => { chunks.push(Buffer.from(chunk)) })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')))
    request.on('error', reject)
  })
}

function readBuffer(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0
    let settled = false

    request.on('data', (chunk) => {
      if (settled) return
      const buffer = Buffer.from(chunk)
      length += buffer.length
      if (length > maxBytes) {
        settled = true
        const error = new Error(`Image exceeds the ${maxBytes} byte limit.`)
        error.statusCode = 413
        reject(error)
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks, length))
    })
    request.on('error', (error) => {
      if (!settled) reject(error)
    })
  })
}

function findReplacementCharacters(value, pathParts = []) {
  if (typeof value === 'string') {
    return value.includes('\uFFFD') ? [pathParts.join('.') || '$'] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findReplacementCharacters(item, [...pathParts, String(index)]))
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => findReplacementCharacters(item, [...pathParts, key]))
  }
  return []
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  return ({
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  })[extension] || 'application/octet-stream'
}

function isFileInside(directory, filePath) {
  const relativePath = path.relative(directory, filePath)
  return relativePath !== '' && !relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath)
}

function parseLocationImagePath(value) {
  const match = LOCATION_IMAGE_PATH_PATTERN.exec(value || '')
  if (!match || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(match[1])) return null
  return {
    digest: match[2],
    extension: match[3],
    filePath: path.join(LOCATION_IMAGES_DIR, match[1], `${match[2]}.${match[3]}`),
    path: value,
  }
}

function detectLocationImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return LOCATION_IMAGE_FORMATS.png
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return LOCATION_IMAGE_FORMATS.jpg
  }
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return LOCATION_IMAGE_FORMATS.gif
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return LOCATION_IMAGE_FORMATS.webp
  }
  return null
}

function normalizeContentType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase()
}

function storeLocationImageAtomically(image, buffer) {
  fs.mkdirSync(path.dirname(image.filePath), { recursive: true })
  if (fs.existsSync(image.filePath)) {
    if (fs.readFileSync(image.filePath).equals(buffer)) return true
    const error = new Error('An image with this content hash already exists with different bytes.')
    error.statusCode = 409
    throw error
  }

  const temporaryPath = `${image.filePath}.${process.pid}-${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, buffer, { flag: 'wx' })
    try {
      fs.renameSync(temporaryPath, image.filePath)
      return false
    } catch (error) {
      if (fs.existsSync(image.filePath) && fs.readFileSync(image.filePath).equals(buffer)) return true
      throw error
    }
  } finally {
    try {
      fs.unlinkSync(temporaryPath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

function writeJsonFileAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`
  let descriptor
  try {
    descriptor = fs.openSync(temporaryPath, 'wx')
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporaryPath, filePath)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    fs.rmSync(temporaryPath, { force: true })
  }
}

function localMapEditorPlugin() {
  return {
    name: 'local-map-editor',
    configureServer(server) {
      server.middlewares.use('/images/locations', (request, response, next) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          next()
          return
        }

        let relativePath
        try {
          relativePath = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname).replace(/^\/+/, '')
        } catch {
          next()
          return
        }
        if (!relativePath) {
          next()
          return
        }

        const filePath = path.resolve(LOCATION_IMAGES_DIR, relativePath)
        if (!isFileInside(LOCATION_IMAGES_DIR, filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          next()
          return
        }

        const stat = fs.statSync(filePath)
        response.setHeader('Content-Type', contentTypeFor(filePath))
        response.setHeader('Content-Length', stat.size)
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        if (request.method === 'HEAD') {
          response.end()
          return
        }
        fs.createReadStream(filePath).pipe(response)
      })

      server.middlewares.use('/images/uploads', (request, response, next) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          next()
          return
        }

        const pathname = new URL(request.url || '/', 'http://localhost').pathname
        const relativePath = decodeURIComponent(pathname).replace(/^\/+/, '')
        if (!relativePath) {
          next()
          return
        }

        const filePath = path.resolve(UPLOADS_DIR, relativePath)
        if (!filePath.startsWith(`${UPLOADS_DIR}${path.sep}`) || !fs.existsSync(filePath)) {
          next()
          return
        }

        response.setHeader('Content-Type', contentTypeFor(filePath))
        if (request.method === 'HEAD') {
          response.end()
          return
        }
        fs.createReadStream(filePath).pipe(response)
      })

      server.middlewares.use('/api/map-data', async (request, response) => {
        if (request.method === 'GET') {
          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          response.end(fs.readFileSync(DATA_FILE, 'utf8'))
          return
        }

        if (request.method !== 'POST') {
          sendJson(response, { error: 'Method not allowed' }, 405)
          return
        }

        try {
          const data = JSON.parse(await readBody(request))
          if (!Array.isArray(data.categories) || !Array.isArray(data.locations) || !Array.isArray(data.routes)) {
            sendJson(response, { error: 'Invalid map data' }, 400)
            return
          }
          const replacementPaths = findReplacementCharacters(data)
          if (replacementPaths.length) {
            sendJson(response, {
              error: 'Refusing to save text that contains replacement characters.',
              paths: replacementPaths.slice(0, 20),
            }, 400)
            return
          }
          writeJsonFileAtomically(DATA_FILE, data)
          sendJson(response, { ok: true })
        } catch (error) {
          sendJson(response, { error: error.message }, 500)
        }
      })

      server.middlewares.use('/api/location-image', async (request, response) => {
        if (request.method !== 'POST' && request.method !== 'DELETE') {
          sendJson(response, { error: 'Method not allowed' }, 405)
          return
        }

        try {
          const requestUrl = new URL(request.url || '/', 'http://localhost')
          const image = parseLocationImagePath(requestUrl.searchParams.get('path'))
          if (!image) {
            sendJson(response, { error: 'Invalid location image path' }, 400)
            return
          }

          if (request.method === 'DELETE') {
            const deleted = fs.existsSync(image.filePath)
            fs.rmSync(image.filePath, { force: true })
            try {
              fs.rmdirSync(path.dirname(image.filePath))
            } catch (error) {
              if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
            }
            sendJson(response, { ok: true, path: image.path, deleted })
            return
          }

          const declaredLength = Number(request.headers['content-length'])
          if (Number.isFinite(declaredLength) && declaredLength > MAX_LOCATION_IMAGE_BYTES) {
            sendJson(response, { error: 'Image exceeds the 10 MiB limit' }, 413)
            return
          }

          const buffer = await readBuffer(request, MAX_LOCATION_IMAGE_BYTES)
          const detectedFormat = detectLocationImage(buffer)
          const requestedFormat = LOCATION_IMAGE_FORMATS[image.extension]
          const contentType = normalizeContentType(request.headers['content-type'])
          if (!detectedFormat || detectedFormat.mimeType !== requestedFormat.mimeType || contentType !== requestedFormat.mimeType) {
            sendJson(response, { error: 'Image extension, content type, and file signature must match' }, 415)
            return
          }

          const digest = createHash('sha256').update(buffer).digest('hex')
          if (digest !== image.digest) {
            sendJson(response, { error: 'Location image filename must match its SHA-256 content hash' }, 400)
            return
          }

          const reused = storeLocationImageAtomically(image, buffer)
          sendJson(response, { ok: true, path: image.path, reused })
        } catch (error) {
          sendJson(response, { error: error.message }, error.statusCode || 500)
        }
      })

      server.middlewares.use('/api/upload-image', async (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, { error: 'Method not allowed' }, 405)
          return
        }

        try {
          const { dataUrl, name = 'image' } = JSON.parse(await readBody(request))
          const match = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(dataUrl || '')
          if (!match) {
            sendJson(response, { error: 'Invalid image data' }, 400)
            return
          }
          fs.mkdirSync(UPLOADS_DIR, { recursive: true })
          const extension = match[1].toLowerCase().replace('jpeg', 'jpg')
          const stem = path.basename(name, path.extname(name)).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 48) || 'image'
          const filename = `${Date.now()}-${stem}.${extension}`
          fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(match[2], 'base64'))
          sendJson(response, { ok: true, path: `/images/uploads/${filename}` })
        } catch (error) {
          sendJson(response, { error: error.message }, 500)
        }
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [vue(), localMapEditorPlugin()],
  server: {
    // The editor writes this file through /api/map-data. Reloading the page
    // after that write would discard the user's current filters and map state.
    watch: {
      ignored: [DATA_FILE, `${DATA_FILE}.*.tmp`],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('map-data.json')) return 'markers'
        },
      },
    },
  },
})
