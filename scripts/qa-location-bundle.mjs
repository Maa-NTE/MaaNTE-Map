import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, zipSync } from 'fflate'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'output', 'qa-location-bundle')
const mergeScript = path.join(root, 'scripts', 'merge-location-changes.mjs')
const targetFile = path.join(output, 'map-data.json')
const assetsDir = path.join(output, 'assets')
const bundleFile = path.join(output, 'changes.zip')
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lz9WJwAAAABJRU5ErkJggg==',
  'base64',
)
const sha256 = createHash('sha256').update(png).digest('hex')
const imagePath = `/images/locations/qa-location/${sha256}.png`
const zipImagePath = `public${imagePath}`
const mapData = {
  map: {},
  categories: [{ id: 'qa-type', group: 'QA', label: 'QA', icon: 'Q', color: '#ffffff' }],
  locations: [],
  routes: [],
}
const changes = {
  version: 2,
  type: 'location-changes',
  upsertLocations: [{
    id: 'qa-location',
    name: 'QA bundle location',
    types: ['qa-type'],
    district: '全地图',
    x: 1,
    y: 2,
    description: '',
    tags: [],
    images: [imagePath],
  }],
  imageAssets: [{
    path: imagePath,
    sha256,
    mimeType: 'image/png',
    size: png.length,
  }],
}

async function runMerge(source, ...args) {
  return execFileAsync(process.execPath, [mergeScript, source, ...args], {
    cwd: root,
    windowsHide: true,
  })
}

async function pathExists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function writeBundle(filePath, payload = changes, entries = {}) {
  const archive = zipSync({
    'location-changes.json': strToU8(`${JSON.stringify(payload, null, 2)}\n`),
    [zipImagePath]: new Uint8Array(png),
    ...entries,
  })
  await writeFile(filePath, archive)
}

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })

try {
  await writeFile(targetFile, `${JSON.stringify(mapData, null, 2)}\n`, 'utf8')
  await writeBundle(bundleFile)

  const first = await runMerge(bundleFile, '--target', targetFile, '--assets-dir', assetsDir)
  const firstStats = JSON.parse(first.stdout)
  assert.equal(firstStats.added, 1)
  assert.equal(firstStats.assetsWritten, 1)
  assert.equal(firstStats.assetsReused, 0)

  const merged = JSON.parse(await readFile(targetFile, 'utf8'))
  assert.deepEqual(merged.locations[0].images, [imagePath])
  assert.deepEqual(
    await readFile(path.join(assetsDir, 'qa-location', `${sha256}.png`)),
    png,
  )

  const second = await runMerge(bundleFile, '--target', targetFile, '--assets-dir', assetsDir)
  const secondStats = JSON.parse(second.stdout)
  assert.equal(secondStats.updated, 1)
  assert.equal(secondStats.assetsWritten, 0)
  assert.equal(secondStats.assetsReused, 1)

  const dryTarget = path.join(output, 'dry-map-data.json')
  const dryAssets = path.join(output, 'dry-assets')
  await writeFile(dryTarget, `${JSON.stringify(mapData, null, 2)}\n`, 'utf8')
  await runMerge(bundleFile, '--target', dryTarget, '--assets-dir', dryAssets, '--dry-run')
  assert.deepEqual(JSON.parse(await readFile(dryTarget, 'utf8')), mapData)
  assert.equal(await pathExists(dryAssets), false)

  const badHashBundle = path.join(output, 'bad-hash.zip')
  await writeBundle(badHashBundle, {
    ...changes,
    imageAssets: [{ ...changes.imageAssets[0], sha256: '0'.repeat(64) }],
  })
  await assert.rejects(
    runMerge(badHashBundle, '--target', dryTarget, '--assets-dir', dryAssets),
    /hash|sha-?256/i,
  )

  const badPathBundle = path.join(output, 'bad-path.zip')
  await writeBundle(badPathBundle, {
    ...changes,
    upsertLocations: [{ ...changes.upsertLocations[0], images: ['/images/locations/../outside.png'] }],
    imageAssets: [{
      ...changes.imageAssets[0],
      path: '/images/locations/../outside.png',
    }],
  })
  await assert.rejects(
    runMerge(badPathBundle, '--target', dryTarget, '--assets-dir', dryAssets),
    /path|asset/i,
  )

  const extraEntryBundle = path.join(output, 'extra-entry.zip')
  await writeBundle(extraEntryBundle, changes, { 'public/images/locations/untracked.png': png })
  await assert.rejects(
    runMerge(extraEntryBundle, '--target', dryTarget, '--assets-dir', dryAssets),
    /untracked|unexpected|asset/i,
  )

  const missingAssetBundle = path.join(output, 'missing-asset.zip')
  await writeFile(missingAssetBundle, zipSync({
    'location-changes.json': strToU8(`${JSON.stringify({ ...changes, imageAssets: [] }, null, 2)}\n`),
  }))
  await assert.rejects(
    runMerge(missingAssetBundle, '--target', dryTarget, '--assets-dir', dryAssets),
    /missing/i,
  )

  const invalidLocationFile = path.join(output, 'invalid-location.json')
  await writeFile(invalidLocationFile, JSON.stringify({
    type: 'location-changes',
    upsertLocations: [{ id: 'invalid', x: 1, y: 2 }],
  }))
  await assert.rejects(
    runMerge(invalidLocationFile, '--target', dryTarget, '--assets-dir', dryAssets),
    /unique id and name|types/i,
  )

  const conflictingIdsFile = path.join(output, 'conflicting-ids.json')
  const { imageAssets: _imageAssets, ...legacyChanges } = changes
  await writeFile(conflictingIdsFile, JSON.stringify({
    ...legacyChanges,
    deletedLocationIds: ['qa-location'],
  }))
  await assert.rejects(
    runMerge(conflictingIdsFile, '--target', dryTarget, '--assets-dir', dryAssets),
    /duplicated|upserts and deletions/i,
  )

  const unsupportedVersionBundle = path.join(output, 'unsupported-version.zip')
  await writeBundle(unsupportedVersionBundle, { ...changes, version: 3 })
  await assert.rejects(
    runMerge(unsupportedVersionBundle, '--target', dryTarget, '--assets-dir', dryAssets),
    /version 2/i,
  )

  const directoryPayloadBundle = path.join(output, 'directory-payload.zip')
  await writeFile(directoryPayloadBundle, zipSync({
    'location-changes.json': strToU8(`${JSON.stringify({ ...changes, imageAssets: [] }, null, 2)}\n`),
    'public/': [new Uint8Array(png), { level: 0 }],
  }))
  await assert.rejects(
    runMerge(directoryPayloadBundle, '--target', dryTarget, '--assets-dir', dryAssets),
    /directory entry|undeclared/i,
  )

  console.log('Location bundle QA passed: merge, bytes, reuse, dry-run, hashes, paths, references, and schema validation.')
} finally {
  await rm(output, { recursive: true, force: true })
}
