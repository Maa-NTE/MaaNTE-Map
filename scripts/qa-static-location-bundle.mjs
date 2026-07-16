import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strFromU8, unzipSync } from 'fflate'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'output', 'qa-static-location-bundle')
const vitePath = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const port = Number(process.env.MAANTE_QA_STATIC_PORT) || 4175
const baseUrl = `http://127.0.0.1:${port}`
const locationId = 'qa-static-location-bundle'
const locationName = 'QA static location bundle'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lz9WJwAAAABJRU5ErkJggg==',
  'base64',
)
const imageHash = createHash('sha256').update(png).digest('hex')
const imagePath = `/images/locations/${locationId}/${imageHash}.png`

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid MAANTE_QA_STATIC_PORT: ${process.env.MAANTE_QA_STATIC_PORT}`)
}

await access(path.join(root, 'dist', 'index.html'))
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })

const server = spawn(
  process.execPath,
  [vitePath, 'preview', '--configLoader', 'runner', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
  },
)

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Vite preview exited with code ${server.exitCode}.`)
    try {
      const response = await fetch(baseUrl)
      if (response.ok) return
    } catch {
      // Vite preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Vite preview did not start in time.')
}

async function stopServer() {
  if (server.exitCode !== null) return
  server.kill()
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])
  if (server.exitCode === null) server.kill('SIGKILL')
}

let browser

try {
  await waitForServer()
  browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    downloadsPath: output,
  })
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true,
  })
  const apiRequests = []
  const consoleErrors = []
  const downloads = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => { consoleErrors.push(error.message) })
  page.on('download', (download) => { downloads.push(download) })
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) {
      apiRequests.push(`${request.method()} ${request.url()}`)
    }
  })

  const response = await page.goto(baseUrl, { waitUntil: 'networkidle' })
  assert.equal(response.status(), 200)
  await page.getByRole('button', { name: '编辑地图' }).click()
  await page.locator('.map-canvas').click({ position: { x: 1450, y: 850 } })
  await page.locator('.editor-form').waitFor()
  await page.getByLabel('点位 ID', { exact: true }).fill(locationId)
  await page.getByLabel('名称', { exact: true }).fill(locationName)
  await page.locator('.type-picker input[type="checkbox"]').first().check()
  await page.locator('.image-upload-field input[type="file"]').setInputFiles({
    name: 'qa-static-point.png',
    mimeType: 'image/png',
    buffer: png,
  })
  const formImage = page.locator('.form-images img')
  await formImage.waitFor()
  assert.equal(await formImage.evaluate((image) => image.complete && image.naturalWidth > 0), true)

  await page.locator('.editor-form').getByRole('button', { name: '确认', exact: true }).click()
  await page.locator('.editor-form').waitFor({ state: 'hidden' })
  const stagedStatus = page.locator('.status-toast')
  await stagedStatus.waitFor()
  assert.match(await stagedStatus.textContent(), /点位修改已暂存/)
  await page.waitForTimeout(300)
  assert.equal(downloads.length, 0)
  assert.deepEqual(apiRequests, [])

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出点位修改包（1）', exact: true }).click(),
  ])
  assert.equal(downloads.length, 1)

  const bundlePath = await download.path()
  assert.ok(bundlePath)
  assert.match(download.suggestedFilename(), /^MaaNTE-location-changes-\d{4}-\d{2}-\d{2}\.zip$/)
  const archive = unzipSync(await readFile(bundlePath))
  const manifestBytes = archive['location-changes.json']
  assert.ok(manifestBytes)
  const manifest = JSON.parse(strFromU8(manifestBytes))
  assert.equal(manifest.version, 2)
  assert.equal(manifest.type, 'location-changes')
  const location = manifest.upsertLocations?.find((item) => item.id === locationId)
  assert.ok(location)
  assert.deepEqual(location.images, [imagePath])
  assert.deepEqual(manifest.imageAssets, [{
    path: imagePath,
    sha256: imageHash,
    mimeType: 'image/png',
    size: png.length,
  }])
  assert.deepEqual(Buffer.from(archive[`public${imagePath}`]), png)

  await page.reload({ waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '编辑地图' }).click()
  await page.locator('.toolbar-file-input').setInputFiles(bundlePath)
  const importStatus = page.locator('.status-toast')
  await importStatus.waitFor()
  assert.match(await importStatus.textContent(), /已导入 1 条点位修改/)
  await page.locator('input[type="search"]').fill(locationName)
  await page.locator('.map-marker').waitFor()
  assert.equal(await page.locator('.map-marker').count(), 1)
  await page.locator('.map-marker').click()
  await page.locator('.detail-card').waitFor()
  assert.equal(await page.locator('.detail-card h2').textContent(), locationName)
  const detailImage = page.locator('.image-gallery img')
  await detailImage.waitFor()
  assert.match(await detailImage.getAttribute('src'), /^blob:/)
  assert.equal(await detailImage.evaluate((image) => image.complete && image.naturalWidth > 0), true)
  assert.deepEqual(apiRequests, [])
  assert.deepEqual(consoleErrors, [])

  console.log('Static location bundle QA passed: production upload, ZIP export, reload, import, and blob preview.')
} finally {
  await browser?.close()
  await stopServer()
  await rm(output, { recursive: true, force: true })
}
