import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const DATA_FILE = process.env.MAANTE_MAP_DATA_FILE
  ? path.resolve(process.env.MAANTE_MAP_DATA_FILE)
  : fileURLToPath(new URL('./src/data/map-data.json', import.meta.url))
const UPLOADS_DIR = process.env.MAANTE_UPLOADS_DIR
  ? path.resolve(process.env.MAANTE_UPLOADS_DIR)
  : fileURLToPath(new URL('./public/images/uploads', import.meta.url))

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

function localMapEditorPlugin() {
  return {
    name: 'local-map-editor',
    configureServer(server) {
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
          fs.writeFileSync(DATA_FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
          sendJson(response, { ok: true })
        } catch (error) {
          sendJson(response, { error: error.message }, 500)
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
      ignored: [DATA_FILE],
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
