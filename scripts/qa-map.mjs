import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { strFromU8, unzipSync } from 'fflate'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'output', 'playwright')
const port = Number(process.env.MAANTE_QA_PORT) || 4174
const baseUrl = `http://127.0.0.1:${port}`
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const vitePath = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const mapDataFile = path.join(root, 'src', 'data', 'map-data.json')
const qaMapDataFile = path.join(output, 'map-data.qa.json')
const qaUploadsDir = path.join(output, 'uploads')
const qaLocationImagesDir = path.join(output, 'location-images')
const qaImageBuffer = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lz9WJwAAAABJRU5ErkJggg==',
  'base64',
)
const qaImageSha256 = createHash('sha256').update(qaImageBuffer).digest('hex')

async function pathExists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

await mkdir(output, { recursive: true })
await rm(qaUploadsDir, { recursive: true, force: true })
await rm(qaLocationImagesDir, { recursive: true, force: true })
await mkdir(qaUploadsDir, { recursive: true })
await copyFile(mapDataFile, qaMapDataFile)

const server = spawn(
  process.execPath,
  [vitePath, '--configLoader', 'runner', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      MAANTE_MAP_DATA_FILE: qaMapDataFile,
      MAANTE_UPLOADS_DIR: qaUploadsDir,
      MAANTE_LOCATION_IMAGES_DIR: qaLocationImagesDir,
    },
  },
)

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(baseUrl)
      if (response.ok) return
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error('Vite server did not start in time')
}

let browser

try {
  await waitForServer()
  browser = await chromium.launch({ executablePath: chromePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  await page.addInitScript(() => {
    class QaWebSocket extends EventTarget {
      constructor(url) {
        super()
        this.url = url
        window.__qaNavigationSocket = this
        setTimeout(() => this.dispatchEvent(new Event('open')), 0)
      }

      close() {
        this.dispatchEvent(new Event('close'))
      }

      receive(payload) {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }))
      }
    }

    window.WebSocket = QaWebSocket
  })
  const consoleErrors = []
  const failedRequests = []

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()}`)
  })

  const response = await page.goto(baseUrl, { waitUntil: 'networkidle' })
  assert.equal(response.status(), 200)
  await page.waitForTimeout(800)
  const initialMapData = await page.evaluate(() => fetch('/api/map-data').then((response) => response.json()))
  const initialCategoryCount = initialMapData.categories.length
  const initialVisibleCategoryCount = initialMapData.categories.filter((category) => !category.isHidden).length
  const teleportCategoryCount = initialMapData.categories.filter((category) => category.group === '传送点' && !category.isHidden).length

  assert.ok((await page.locator('.map-marker').count()) > 0)
  assert.ok((await page.locator('.marker-cluster').count()) > 0)
  assert.equal(await page.locator('.location-list').count(), 0)
  assert.equal(await page.locator('.location-card').count(), 0)
  assert.ok((await page.locator('.leaflet-tile-loaded').count()) > 0)
  assert.equal(await page.locator('.brand-mark').getAttribute('src'), '/logo.png')
  assert.equal(await page.title(), 'MaaNTE在线地图工具')
  assert.equal(await page.locator('.map-canvas').getAttribute('data-min-zoom'), '-3')
  assert.equal(await page.locator('.map-canvas').getAttribute('data-initial-zoom'), '-3')
  await page.getByText('实时定位', { exact: true }).click()
  await page.evaluate(() => {
    window.__qaNavigationSocket.receive({
      type: 'navi-state',
      version: 1,
      position: {
        pixelX: 5788,
        pixelY: 8902,
        score: 0.82,
        mode: 'local',
        sourceWidth: 11264,
        sourceHeight: 11264,
      },
      angle: 123.4,
      angleConfidence: 0.96,
      timestamp: Date.now() / 1000,
    })
  })
  await page.locator('.navigation-arrow').waitFor()
  assert.equal(
    await page.locator('.navigation-arrow img').evaluate((element) => element.style.transform),
    'translateZ(0px) rotate(123.4deg)',
  )
  assert.deepEqual(await page.evaluate(async () => {
    const { mapPixelToMapLatLng } = await import('/src/data/locations.js')
    return mapPixelToMapLatLng({
      pixelX: 5788,
      pixelY: 8902,
      sourceWidth: 11264,
      sourceHeight: 11264,
    })
  }), [-17804, 11576])
  assert.match(await page.locator('.map-hud .game-coordinate').innerText(), /^XYZ -?\d+, -?\d+, --$/)
  await page.evaluate(() => {
    window.__qaNavigationSocket.receive({
      type: 'navi-state',
      version: 1,
      position: {
        x: -134394.56,
        y: 199913.53,
        z: 11416.17,
        pixelX: 4090,
        pixelY: 6750,
        sourceWidth: 11264,
        sourceHeight: 11264,
      },
      angle: 123.4,
    })
  })
  await page.waitForFunction(() => document.querySelector('.game-coordinate')?.textContent.includes('-134395'))
  assert.equal(
    (await page.locator('.map-hud .game-coordinate').innerText()).replace(/\s+/g, ' '),
    'XYZ -134395, 199914, 11416',
  )
  assert.equal(await page.locator('.map-hud .navigation-status').innerText(), 'NAVI CONNECTED')
  assert.equal(await page.locator('.map-hud').getByText(/^ML |^POS |^ANGLE /).count(), 0)
  const categoryListBox = await page.locator('.category-list').boundingBox()
  const sidebarFooterBox = await page.locator('.sidebar-footer').boundingBox()
  assert.ok(categoryListBox.height > 268)
  assert.ok(sidebarFooterBox.y > categoryListBox.y + categoryListBox.height)
  assert.equal(await page.locator('.category-button').count(), initialVisibleCategoryCount + 1)
  await page.screenshot({ path: path.join(output, 'map-home.png') })

  await page.locator('.sidebar-toggle').click()
  const visibleMarkerIndex = await page.locator('.map-marker').evaluateAll((markers) => (
    markers.findIndex((marker) => {
      const box = marker.getBoundingClientRect()
      return box.width > 0
        && box.height > 0
        && box.left >= 0
        && box.top >= 0
        && box.right <= window.innerWidth
        && box.bottom <= window.innerHeight
    })
  ))
  assert.ok(visibleMarkerIndex >= 0)
  await page.locator('.map-marker').nth(visibleMarkerIndex).dispatchEvent('click')
  await page.locator('.detail-card').waitFor()
  assert.match(await page.locator('.coordinate-row code').innerText(), /^-?\d+\.\d{3}, -?\d+\.\d{3}$/)

  await page.locator('.primary-action').click()
  assert.match(await page.locator('.progress-copy strong').innerText(), /\d+%/)
  await page.getByRole('button', { name: '关闭详情' }).click()

  await page.locator('input[type="search"]').fill('#002')
  assert.equal(await page.locator('input[type="search"]').inputValue(), '#002')
  assert.equal(await page.locator('.detail-card').count(), 0)
  await page.screenshot({ path: path.join(output, 'map-search.png') })

  await page.locator('input[type="search"]').fill('')
  await page.locator('.sidebar-toggle').click()
  const clearButton = page.locator('.sidebar').getByRole('button', { name: '清空', exact: true })
  await clearButton.click()
  assert.ok((await page.locator('.map-marker').count()) > 0)
  assert.equal(await page.locator('.category-button:not(.category-button--muted)').count(), teleportCategoryCount)
  await page.getByText('传送点保持开启', { exact: true }).click()
  await clearButton.click()
  assert.equal(await page.locator('.map-marker').count(), 0)
  await page.evaluate(async () => {
    window.__qaMapStatePreserved = true
    const data = await fetch('/api/map-data').then((response) => response.json())
    await fetch('/api/map-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  })
  await page.waitForTimeout(500)
  assert.equal(await page.evaluate(() => window.__qaMapStatePreserved), true)
  assert.equal(await page.locator('.category-button:not(.category-button--muted)').count(), 0)
  await page.getByRole('button', { name: '全选', exact: true }).click()
  const firstCategory = page.locator('.category-button').nth(1)
  const markerCount = await page.locator('.map-marker').count()
  await firstCategory.click()
  assert.notEqual(await page.locator('.map-marker').count(), markerCount)
  await firstCategory.click()

  await page.getByRole('button', { name: '编辑地图' }).click()
  await page.locator('.map-canvas').click({ position: { x: 1480, y: 880 } })
  await page.locator('.editor-form').waitFor()
  assert.equal(await page.locator('.type-picker input[type="checkbox"]').count(), initialCategoryCount)
  assert.ok(await page.getByText('异象委托', { exact: true }).count() >= 1)
  assert.equal(await page.getByText('搜索关键词（可选）', { exact: true }).count(), 1)
  assert.equal(await page.getByLabel('选择标记大类').inputValue(), '')
  const districtSelect = page.locator('.editor-form label').filter({ hasText: '区域' }).locator('select')
  assert.equal(await districtSelect.evaluate((element) => element.tagName), 'SELECT')
  await districtSelect.selectOption('未闻浦')
  await page.getByLabel('点位 ID', { exact: true }).fill('qa-custom-location')
  await page.getByLabel('名称', { exact: true }).fill('QA 自定义类型点位')
  await page.getByPlaceholder('输入稳定 ID，例如 witch-house').fill('qa-custom-type')
  await page.getByPlaceholder('输入自定义类型名称').fill('测试已有大类类型')
  await page.getByLabel('选择标记大类').selectOption('传送点')
  await page.getByRole('button', { name: '+ 添加类型', exact: true }).click()
  assert.equal(await page.locator('.type-picker input[type="checkbox"]').count(), initialCategoryCount + 1)
  assert.equal(await page.getByRole('checkbox', { name: '测试已有大类类型', exact: true }).isChecked(), true)
  assert.equal(await page.getByRole('checkbox', { name: '测试已有大类类型', exact: true }).locator('..').getAttribute('data-category-id'), 'qa-custom-type')
  assert.equal(await page.getByRole('checkbox', { name: '测试已有大类类型', exact: true }).locator('..').getAttribute('data-category-group'), '传送点')
  assert.equal(await page.getByLabel('选择标记大类').inputValue(), '传送点')
  await page.getByPlaceholder('输入稳定 ID，例如 witch-house').fill('qa-custom-type')
  await page.getByPlaceholder('输入自定义类型名称').fill('测试新大类类型')
  await page.getByPlaceholder('新建大类（可选）').fill('测试新大类')
  await page.getByRole('button', { name: '+ 添加类型', exact: true }).click()
  assert.equal(await page.locator('.type-picker input[type="checkbox"]').count(), initialCategoryCount + 2)
  assert.equal(await page.getByRole('checkbox', { name: '测试新大类类型', exact: true }).isChecked(), true)
  assert.equal(await page.getByRole('checkbox', { name: '测试新大类类型', exact: true }).locator('..').getAttribute('data-category-id'), 'qa-custom-type-2')
  assert.equal(await page.getByRole('checkbox', { name: '测试新大类类型', exact: true }).locator('..').getAttribute('data-category-group'), '测试新大类')
  assert.equal(await page.getByLabel('选择标记大类').inputValue(), '测试新大类')
  await page.locator('.editor-form input[type="file"]').setInputFiles({
    name: 'qa-point.png',
    mimeType: 'image/png',
    buffer: qaImageBuffer,
  })
  await page.locator('.form-images img').waitFor()
  assert.equal(await pathExists(qaLocationImagesDir), false)
  await page.getByRole('button', { name: '移除第 1 张点位截图' }).click()
  assert.equal(await page.locator('.form-images img').count(), 0)
  assert.equal(await pathExists(qaLocationImagesDir), false)
  await page.locator('.editor-form input[type="file"]').setInputFiles({
    name: 'qa-point.png',
    mimeType: 'image/png',
    buffer: qaImageBuffer,
  })
  await page.locator('.form-images img').waitFor()
  await page.getByRole('button', { name: '保存' }).click()
  await page.locator('.editor-form').waitFor({ state: 'hidden' })
  const persistedMapData = await page.evaluate(() => fetch('/api/map-data').then((response) => response.json()))
  assert.equal(persistedMapData.categories.find((category) => category.id === 'qa-custom-type').group, '传送点')
  assert.equal(persistedMapData.categories.find((category) => category.id === 'qa-custom-type-2').group, '测试新大类')
  const savedLocation = persistedMapData.locations.find((location) => location.name === 'QA 自定义类型点位')
  assert.ok(savedLocation)
  assert.equal(savedLocation.id, 'qa-custom-location')
  assert.equal(savedLocation.district, '未闻浦')
  assert.equal(savedLocation.images[0], `/images/locations/qa-custom-location/${qaImageSha256}.png`)
  const qaStoredImagePath = path.join(qaLocationImagesDir, 'qa-custom-location', `${qaImageSha256}.png`)
  assert.deepEqual(
    await readFile(qaStoredImagePath),
    qaImageBuffer,
  )
  const locationChangesDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: /导出点位修改/ }).click()
  const locationChangesDownloadResult = await locationChangesDownload
  assert.match(locationChangesDownloadResult.suggestedFilename(), /^MaaNTE-location-changes-\d{4}-\d{2}-\d{2}\.zip$/)
  const locationChangesPath = await locationChangesDownloadResult.path()
  const locationChangesArchive = unzipSync(await readFile(locationChangesPath))
  const locationChanges = JSON.parse(strFromU8(locationChangesArchive['location-changes.json']))
  assert.deepEqual(locationChanges.categories.find((category) => category.id === 'qa-custom-type'), {
    id: 'qa-custom-type',
    group: '传送点',
    label: '测试已有大类类型',
  })
  assert.deepEqual(locationChanges.categories.find((category) => category.id === 'qa-custom-type-2'), {
    id: 'qa-custom-type-2',
    group: '测试新大类',
    label: '测试新大类类型',
    isNewGroup: true,
  })
  for (const type of locationChanges.upsertLocations.find((location) => location.id === savedLocation.id).types) {
    assert.ok(locationChanges.categories.find((category) => category.id === type)?.group)
  }
  assert.equal(locationChanges.upsertLocations.find((location) => location.id === savedLocation.id).images[0], savedLocation.images[0])
  assert.deepEqual(locationChanges.imageAssets, [{
    path: savedLocation.images[0],
    sha256: qaImageSha256,
    mimeType: 'image/png',
    size: qaImageBuffer.length,
  }])
  assert.deepEqual(Buffer.from(locationChangesArchive[`public${savedLocation.images[0]}`]), qaImageBuffer)
  await page.locator('.leaflet-marker-icon[title="QA 自定义类型点位"]').dispatchEvent('click')
  await page.locator('.detail-card').waitFor()
  await page.locator('.detail-card').getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByRole('button', { name: '移除第 1 张点位截图' }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.locator('.editor-form').waitFor({ state: 'hidden' })
  for (let attempt = 0; attempt < 20 && await pathExists(qaStoredImagePath); attempt += 1) {
    await page.waitForTimeout(50)
  }
  assert.equal(await pathExists(qaStoredImagePath), false)
  await page.locator('.leaflet-marker-icon[title="QA 自定义类型点位"]').dispatchEvent('click')
  await page.locator('.detail-card').waitFor()
  await page.locator('.detail-card').getByRole('button', { name: '编辑', exact: true }).click()
  await page.locator('.editor-form input[type="file"]').setInputFiles({
    name: 'qa-point.png',
    mimeType: 'image/png',
    buffer: qaImageBuffer,
  })
  await page.locator('.form-images img').waitFor()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.locator('.editor-form').waitFor({ state: 'hidden' })
  assert.deepEqual(await readFile(qaStoredImagePath), qaImageBuffer)
  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('.detail-card .danger-button').click()
  await page.locator('.detail-card').waitFor({ state: 'hidden' })
  for (let attempt = 0; attempt < 20 && await pathExists(qaStoredImagePath); attempt += 1) {
    await page.waitForTimeout(50)
  }
  assert.equal(await pathExists(qaStoredImagePath), false)
  await page.locator('.toolbar-file-input').setInputFiles({
    name: 'missing-image-location.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      version: 2,
      type: 'location-changes',
      upsertLocations: [{
        id: 'qa-missing-image',
        name: 'QA missing image',
        types: [initialMapData.categories[0].id],
        district: '全地图',
        x: 1,
        y: 2,
        description: '',
        tags: [],
        images: [`/images/locations/qa-missing-image/${'0'.repeat(64)}.png`],
      }],
    })),
  })
  await page.getByText(/点位修改导入失败/).waitFor()
  assert.equal(await page.evaluate(() => fetch('/api/map-data')
    .then((response) => response.json())
    .then((data) => data.locations.some((location) => location.id === 'qa-missing-image'))), false)
  await page.evaluate(async (data) => {
    await fetch('/api/map-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  }, initialMapData)

  await page.getByRole('button', { name: '路线' }).click()
  await page.locator('.route-panel').waitFor()
  page.once('dialog', (dialog) => dialog.accept('QA 路线'))
  await page.getByRole('button', { name: '+ 新建', exact: true }).click()
  await page.getByRole('button', { name: '+ 添加路段', exact: true }).click()
  await page.locator('.map-canvas').click({ position: { x: 760, y: 520 } })
  await page.locator('.route-point-handle').waitFor()
  await page.waitForTimeout(350)
  await page.locator('.map-canvas').click({ position: { x: 1040, y: 700 } })
  await page.locator('.route-point-handle').nth(1).waitFor()
  assert.equal(await page.locator('.route-point-handle').count(), 2)
  page.once('dialog', (dialog) => dialog.accept('QA 空白点路段'))
  await page.getByRole('button', { name: '完成', exact: true }).click()
  assert.equal(await page.getByText('QA 空白点路段', { exact: true }).count(), 1)
  assert.equal(await page.getByText('2 个点', { exact: true }).count(), 1)
  assert.equal(await page.evaluate(() => {
    const routes = JSON.parse(localStorage.getItem('nte-routes') || '[]')
    return routes.some((route) => route.segments?.some((segment) => segment.points?.length === 2))
  }), true)
  const routeDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click()
  assert.match((await routeDownload).suggestedFilename(), /^MaaNTE-routes-\d{4}-\d{2}-\d{2}\.json$/)
  await page.locator('.route-file-actions input[type="file"]').setInputFiles({
    name: 'qa-routes.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      version: 1,
      routes: [{
        id: 'qa-imported-route',
        name: 'QA 导入路线',
        segments: [{
          id: 'qa-imported-segment',
          name: 'QA 导入路段',
          points: [{ x: 12500, y: 24500 }, { x: 16500, y: 30500 }],
        }],
      }],
    })),
  })
  await page.locator('.route-list').getByText('QA 导入路线', { exact: true }).waitFor()
  assert.equal(await page.locator('.route-point').count(), 2)
  await page.evaluate(async (data) => {
    localStorage.removeItem('nte-routes')
    await fetch('/api/map-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  }, initialMapData)

  assert.deepEqual(consoleErrors, [])
  assert.deepEqual(failedRequests, [])

  console.log('QA passed: tiles, clusters, details, progress, category filters, local editor, route points, and route JSON.')
} finally {
  await browser?.close()
  server.kill()
  await rm(qaMapDataFile, { force: true })
  await rm(qaUploadsDir, { recursive: true, force: true })
  await rm(qaLocationImagesDir, { recursive: true, force: true })
}
