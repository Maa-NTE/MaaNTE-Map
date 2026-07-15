import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { unzipSync } from 'fflate'

const DEFAULT_TARGET_FILE = path.resolve('src/data/map-data.json')
const DEFAULT_ASSETS_DIR = path.resolve('public/images/locations')
const BUNDLE_MANIFEST_PATH = 'location-changes.json'
const MAX_IMAGE_ASSET_BYTES = 10 * 1024 * 1024
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024
const MAX_BUNDLE_MANIFEST_BYTES = 8 * 1024 * 1024
const MAX_BUNDLE_ENTRIES = 4096
const IMAGE_PATH_PATTERN = /^\/images\/locations\/([a-z0-9_-]{1,80})\/([a-f0-9]{64})\.(png|jpg|webp|gif)$/
const MIME_TYPE_BY_EXTENSION = {
  gif: 'image/gif',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

function parseArgs(argv) {
  const options = {
    sourceFile: '',
    targetFile: DEFAULT_TARGET_FILE,
    assetsDir: DEFAULT_ASSETS_DIR,
    dryRun: false,
    mergeCategories: true,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = (option) => {
      index += 1
      if (index >= argv.length || !argv[index]) throw new Error(`Missing value for ${option}.`)
      return argv[index]
    }

    if (arg === '--target') options.targetFile = path.resolve(next('--target'))
    else if (arg.startsWith('--target=')) options.targetFile = path.resolve(arg.slice('--target='.length))
    else if (arg === '--assets-dir') options.assetsDir = path.resolve(next('--assets-dir'))
    else if (arg.startsWith('--assets-dir=')) options.assetsDir = path.resolve(arg.slice('--assets-dir='.length))
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--no-merge-categories') options.mergeCategories = false
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (!options.sourceFile) {
      options.sourceFile = path.resolve(arg)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!options.sourceFile) {
    throw new Error('Missing source location-changes JSON or ZIP file.')
  }

  return options
}

function printHelp() {
  console.log(`Usage:
  npm run merge:locations -- <location-changes.json|location-changes.zip>
  npm run merge:locations -- C:/Users/owo/Downloads/点位.json
  npm run merge:locations -- C:/Users/owo/Downloads/点位.zip
  npm run merge:locations -- output/imports/nte-location-changes.json --dry-run

Options:
  --target <file>             Target map data file. Default: ${relative(DEFAULT_TARGET_FILE)}
  --assets-dir <dir>          Target image asset root. Default: ${relative(DEFAULT_ASSETS_DIR)}
  --dry-run                   Print merge statistics without writing the target file.
  --no-merge-categories       Do not append new category definitions from the source file.
`)
}

function relative(filePath) {
  return path.relative(process.cwd(), filePath).replaceAll(path.sep, '/')
}

function parseJson(content, label) {
  try {
    return JSON.parse(Buffer.from(content).toString('utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${label}: ${error.message}`)
    }
    throw error
  }
}

async function readJson(filePath) {
  return parseJson(await fs.readFile(filePath), relative(filePath))
}

function findZipEndOfCentralDirectory(data) {
  const minimumOffset = Math.max(0, data.length - 22 - 0xffff)
  for (let offset = data.length - 22; offset >= minimumOffset; offset -= 1) {
    if (data.readUInt32LE(offset) !== 0x06054b50) continue
    const commentLength = data.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === data.length) return offset
  }
  return -1
}

function validateZipEntryPath(entryPath, sourceLabel) {
  if (!entryPath
    || entryPath.includes('\\')
    || entryPath.includes('\0')
    || entryPath.startsWith('/')
    || /^[a-zA-Z]:/.test(entryPath)) {
    throw new Error(`Invalid ZIP entry path in ${sourceLabel}: ${entryPath || '<empty>'}`)
  }

  const parts = entryPath.endsWith('/') ? entryPath.slice(0, -1).split('/') : entryPath.split('/')
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid ZIP entry path in ${sourceLabel}: ${entryPath}`)
  }
}

// unzipSync returns an object, so duplicate names would otherwise overwrite each other.
// Read the central directory first to reject ambiguous archives before extraction.
function listZipEntries(data, sourceLabel) {
  const endOffset = findZipEndOfCentralDirectory(data)
  if (endOffset < 0) throw new Error(`Invalid ZIP in ${sourceLabel}: central directory not found.`)

  const diskNumber = data.readUInt16LE(endOffset + 4)
  const centralDirectoryDisk = data.readUInt16LE(endOffset + 6)
  const entriesOnDisk = data.readUInt16LE(endOffset + 8)
  const entryCount = data.readUInt16LE(endOffset + 10)
  const centralDirectorySize = data.readUInt32LE(endOffset + 12)
  const centralDirectoryOffset = data.readUInt32LE(endOffset + 16)
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error(`Invalid ZIP in ${sourceLabel}: multi-disk archives are not supported.`)
  }
  if (entryCount > MAX_BUNDLE_ENTRIES
    || entryCount === 0xffff
    || centralDirectorySize === 0xffffffff
    || centralDirectoryOffset === 0xffffffff) {
    throw new Error(`Invalid ZIP in ${sourceLabel}: ZIP64 archives are not supported.`)
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize
  if (centralDirectoryEnd > endOffset || centralDirectoryOffset > data.length) {
    throw new Error(`Invalid ZIP in ${sourceLabel}: central directory is out of bounds.`)
  }

  const entries = []
  const entryNames = new Set()
  const caseInsensitiveEntryNames = new Set()
  let totalUncompressedSize = 0
  let cursor = centralDirectoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralDirectoryEnd || data.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`Invalid ZIP in ${sourceLabel}: malformed central directory entry ${index}.`)
    }

    const flags = data.readUInt16LE(cursor + 8)
    if (flags & 0x0001) throw new Error(`Invalid ZIP in ${sourceLabel}: encrypted entries are not supported.`)
    const compressedSize = data.readUInt32LE(cursor + 20)
    const uncompressedSize = data.readUInt32LE(cursor + 24)
    const nameLength = data.readUInt16LE(cursor + 28)
    const extraLength = data.readUInt16LE(cursor + 30)
    const commentLength = data.readUInt16LE(cursor + 32)
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength
    if (entryEnd > centralDirectoryEnd) {
      throw new Error(`Invalid ZIP in ${sourceLabel}: truncated central directory entry ${index}.`)
    }

    const entryPath = data.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    if (entryPath.includes('\uFFFD')) {
      throw new Error(`Invalid ZIP in ${sourceLabel}: entry ${index} has an invalid UTF-8 name.`)
    }
    validateZipEntryPath(entryPath, sourceLabel)
    if (entryPath.endsWith('/')) {
      if (compressedSize !== 0 || uncompressedSize !== 0) {
        throw new Error(`Invalid ZIP directory entry in ${sourceLabel}: ${entryPath}`)
      }
    } else {
      const entryLimit = entryPath === BUNDLE_MANIFEST_PATH ? MAX_BUNDLE_MANIFEST_BYTES : MAX_IMAGE_ASSET_BYTES
      if (uncompressedSize === 0xffffffff || uncompressedSize > entryLimit) {
        throw new Error(`Oversized ZIP entry in ${sourceLabel}: ${entryPath}`)
      }
      totalUncompressedSize += uncompressedSize
      if (totalUncompressedSize > MAX_BUNDLE_BYTES) {
        throw new Error(`ZIP contents exceed the size limit in ${sourceLabel}.`)
      }
    }
    const caseInsensitivePath = entryPath.toLowerCase()
    if (entryNames.has(entryPath) || caseInsensitiveEntryNames.has(caseInsensitivePath)) {
      throw new Error(`Duplicate ZIP entry in ${sourceLabel}: ${entryPath}`)
    }
    entryNames.add(entryPath)
    caseInsensitiveEntryNames.add(caseInsensitivePath)
    entries.push({ path: entryPath, isDirectory: entryPath.endsWith('/') })
    cursor = entryEnd
  }

  if (cursor !== centralDirectoryEnd) {
    throw new Error(`Invalid ZIP in ${sourceLabel}: unexpected central directory data.`)
  }
  return entries
}

function hasZipSignature(data) {
  if (data.length < 4) return false
  const signature = data.readUInt32LE(0)
  return signature === 0x04034b50 || signature === 0x06054b50 || signature === 0x08074b50
}

async function readChangesSource(filePath) {
  const sourceLabel = relative(filePath)
  const sourceStat = await fs.stat(filePath)
  if (!sourceStat.isFile()) throw new Error(`Source is not a file: ${sourceLabel}`)
  const sourceHandle = await fs.open(filePath, 'r')
  const signatureBuffer = Buffer.alloc(4)
  try {
    await sourceHandle.read(signatureBuffer, 0, signatureBuffer.length, 0)
  } finally {
    await sourceHandle.close()
  }
  const isZip = path.extname(filePath).toLowerCase() === '.zip' || hasZipSignature(signatureBuffer)
  const sizeLimit = isZip ? MAX_BUNDLE_BYTES : MAX_BUNDLE_MANIFEST_BYTES
  if (sourceStat.size > sizeLimit) throw new Error(`Source exceeds the size limit: ${sourceLabel}`)
  const data = await fs.readFile(filePath)
  if (!isZip) {
    return { changes: parseJson(data, sourceLabel), bundle: null }
  }
  if (data.length > MAX_BUNDLE_BYTES) throw new Error(`ZIP bundle exceeds the size limit: ${sourceLabel}`)

  const entries = listZipEntries(data, sourceLabel)
  const manifestEntry = entries.find((entry) => entry.path === BUNDLE_MANIFEST_PATH && !entry.isDirectory)
  if (!manifestEntry) throw new Error(`ZIP bundle is missing root ${BUNDLE_MANIFEST_PATH}.`)

  let files
  try {
    files = unzipSync(data)
  } catch (error) {
    throw new Error(`Invalid ZIP in ${sourceLabel}: ${error.message}`)
  }

  for (const entry of entries) {
    if (!entry.isDirectory && !Object.hasOwn(files, entry.path)) {
      throw new Error(`ZIP entry could not be extracted: ${entry.path}`)
    }
  }
  for (const extractedPath of Object.keys(files)) {
    if (!entries.some((entry) => entry.path === extractedPath)) {
      throw new Error(`ZIP contains an unlisted extracted entry: ${extractedPath}`)
    }
  }

  return {
    changes: parseJson(files[BUNDLE_MANIFEST_PATH], `${sourceLabel}:${BUNDLE_MANIFEST_PATH}`),
    bundle: { entries, files },
  }
}

function assertArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`)
}

function validateMapData(mapData) {
  assertArray(mapData.categories, 'target categories')
  assertArray(mapData.locations, 'target locations')
}

function validateChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new Error('Source location changes must be an object.')
  }
  if (changes.type && changes.type !== 'location-changes') {
    throw new Error(`Unsupported changes type: ${changes.type}`)
  }

  if (changes.categories !== undefined) assertArray(changes.categories, 'source categories')
  if (changes.upsertLocations !== undefined) assertArray(changes.upsertLocations, 'source upsertLocations')
  if (changes.deletedLocationIds !== undefined) assertArray(changes.deletedLocationIds, 'source deletedLocationIds')
  if (changes.imageAssets !== undefined) assertArray(changes.imageAssets, 'source imageAssets')

  const upsertIds = new Set()
  for (const [index, location] of (changes.upsertLocations || []).entries()) {
    const label = `source upsertLocations[${index}]`
    if (!location || typeof location !== 'object' || Array.isArray(location)) {
      throw new Error(`${label} must be an object.`)
    }
    const id = typeof location.id === 'string' ? location.id.trim() : ''
    const name = typeof location.name === 'string' ? location.name.trim() : ''
    if (!id || !name || upsertIds.has(id)) throw new Error(`${label} must include a unique id and name.`)
    if (!Number.isFinite(location.x) || !Number.isFinite(location.y)) {
      throw new Error(`${label} must include finite numeric x and y coordinates.`)
    }
    if (!Array.isArray(location.types)
      || !location.types.length
      || location.types.some((type) => typeof type !== 'string' || !type)) {
      throw new Error(`${label}.types must be a non-empty string array.`)
    }
    if (!Array.isArray(location.tags) || location.tags.some((tag) => typeof tag !== 'string')) {
      throw new Error(`${label}.tags must be a string array.`)
    }
    if (!Array.isArray(location.images)
      || location.images.length > 8
      || location.images.some((imagePath) => typeof imagePath !== 'string' || !imagePath)) {
      throw new Error(`${label}.images must contain at most 8 non-empty string paths.`)
    }
    if (typeof location.district !== 'string' || typeof location.description !== 'string') {
      throw new Error(`${label}.district and ${label}.description must be strings.`)
    }
    upsertIds.add(id)
  }

  if ((changes.deletedLocationIds || []).some((id) => typeof id !== 'string' || !id)) {
    throw new Error('source deletedLocationIds must contain non-empty strings.')
  }
  const deletedIds = new Set(changes.deletedLocationIds || [])
  if (deletedIds.size !== (changes.deletedLocationIds || []).length
    || [...upsertIds].some((id) => deletedIds.has(id))) {
    throw new Error('source location IDs must not be duplicated across upserts and deletions.')
  }
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function detectImageType(data) {
  if (data.length >= 8
    && data[0] === 0x89
    && data[1] === 0x50
    && data[2] === 0x4e
    && data[3] === 0x47
    && data[4] === 0x0d
    && data[5] === 0x0a
    && data[6] === 0x1a
    && data[7] === 0x0a) {
    return { extension: 'png', mimeType: 'image/png' }
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { extension: 'jpg', mimeType: 'image/jpeg' }
  }
  if (data.length >= 6
    && data[0] === 0x47
    && data[1] === 0x49
    && data[2] === 0x46
    && data[3] === 0x38
    && (data[4] === 0x37 || data[4] === 0x39)
    && data[5] === 0x61) {
    return { extension: 'gif', mimeType: 'image/gif' }
  }
  if (data.length >= 12
    && data[0] === 0x52
    && data[1] === 0x49
    && data[2] === 0x46
    && data[3] === 0x46
    && data[8] === 0x57
    && data[9] === 0x45
    && data[10] === 0x42
    && data[11] === 0x50) {
    return { extension: 'webp', mimeType: 'image/webp' }
  }
  return null
}

function assertImageType(data, asset, label) {
  const detectedType = detectImageType(data)
  if (!detectedType
    || detectedType.extension !== asset.extension
    || detectedType.mimeType !== asset.mimeType) {
    throw new Error(`Image asset content type mismatch for ${label}.`)
  }
}

function sanitizeLocationImageId(value) {
  const sanitized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'location'
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(sanitized)
    ? `location-${sanitized}`
    : sanitized
}

function collectUpsertImageReferences(changes) {
  const references = new Map()
  for (const [locationIndex, location] of (changes.upsertLocations || []).entries()) {
    if (location.images === undefined) continue
    assertArray(location.images, `source upsertLocations[${locationIndex}].images`)
    for (const [imageIndex, imagePath] of location.images.entries()) {
      if (typeof imagePath !== 'string' || !imagePath) {
        throw new Error(`source upsertLocations[${locationIndex}].images[${imageIndex}] must be a non-empty string.`)
      }
      if (!references.has(imagePath)) references.set(imagePath, new Set())
      references.get(imagePath).add(sanitizeLocationImageId(location.id))
    }
  }
  return references
}

function validateBundleAssets(changes, bundle) {
  if (!bundle) {
    if ((changes.imageAssets || []).length) {
      throw new Error('Image assets must be supplied in a ZIP bundle.')
    }
    return []
  }
  const references = collectUpsertImageReferences(changes)
  const expectedFiles = new Set([BUNDLE_MANIFEST_PATH])
  const assetPaths = new Set()
  const caseInsensitiveAssetPaths = new Set()
  const assets = (changes.imageAssets || []).map((asset, index) => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
      throw new Error(`imageAssets[${index}] must be an object.`)
    }

    const match = typeof asset.path === 'string' ? IMAGE_PATH_PATTERN.exec(asset.path) : null
    if (!match) {
      throw new Error(`Invalid imageAssets[${index}].path: ${asset.path || '<empty>'}`)
    }
    const [, safeId, pathHash, extension] = match
    if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
      throw new Error(`Invalid imageAssets[${index}].sha256.`)
    }
    if (asset.sha256 !== pathHash) {
      throw new Error(`imageAssets[${index}] SHA-256 does not match its path.`)
    }
    if (asset.mimeType !== MIME_TYPE_BY_EXTENSION[extension]) {
      throw new Error(`imageAssets[${index}] MIME type does not match .${extension}.`)
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_IMAGE_ASSET_BYTES) {
      throw new Error(`Invalid imageAssets[${index}].size.`)
    }
    if (!references.has(asset.path)) {
      throw new Error(`Image asset is not referenced by an upsert location: ${asset.path}`)
    }
    if ([...references.get(asset.path)].some((locationSafeId) => locationSafeId !== safeId)) {
      throw new Error(`Image asset directory does not match its location ID: ${asset.path}`)
    }

    const caseInsensitivePath = asset.path.toLowerCase()
    if (assetPaths.has(asset.path) || caseInsensitiveAssetPaths.has(caseInsensitivePath)) {
      throw new Error(`Duplicate image asset path: ${asset.path}`)
    }
    assetPaths.add(asset.path)
    caseInsensitiveAssetPaths.add(caseInsensitivePath)

    const zipPath = `public${asset.path}`
    expectedFiles.add(zipPath)
    if (!Object.hasOwn(bundle.files, zipPath)) {
      throw new Error(`ZIP bundle is missing image asset: ${zipPath}`)
    }
    const data = Buffer.from(bundle.files[zipPath])
    if (data.length !== asset.size) {
      throw new Error(`Image asset size mismatch for ${asset.path}: expected ${asset.size}, got ${data.length}.`)
    }
    assertImageType(data, { extension, mimeType: asset.mimeType }, asset.path)
    const actualHash = sha256(data)
    if (actualHash !== asset.sha256) {
      throw new Error(`Image asset SHA-256 mismatch for ${asset.path}: expected ${asset.sha256}, got ${actualHash}.`)
    }

    return {
      path: asset.path,
      relativePath: path.join(safeId, `${pathHash}.${extension}`),
      sha256: asset.sha256,
      mimeType: asset.mimeType,
      extension,
      size: asset.size,
      data,
    }
  })

  for (const entry of bundle.entries) {
    if (!entry.isDirectory && !expectedFiles.has(entry.path)) {
      throw new Error(`ZIP bundle contains an undeclared file: ${entry.path}`)
    }
    if (entry.isDirectory && ![...expectedFiles].some((filePath) => filePath.startsWith(entry.path))) {
      throw new Error(`ZIP bundle contains an undeclared directory: ${entry.path}`)
    }
  }
  for (const expectedPath of expectedFiles) {
    if (!bundle.entries.some((entry) => entry.path === expectedPath && !entry.isDirectory)) {
      throw new Error(`ZIP bundle is missing declared file: ${expectedPath}`)
    }
  }
  return assets
}

async function validateExistingImageReferences(changes, bundledAssets, assetsDir) {
  const bundledPaths = new Set(bundledAssets.map((asset) => asset.path))
  const references = collectUpsertImageReferences(changes)
  const root = path.resolve(assetsDir)

  for (const [imagePath, locationSafeIds] of references) {
    const match = IMAGE_PATH_PATTERN.exec(imagePath)
    if (!match) continue
    const [, safeId, pathHash, extension] = match
    if ([...locationSafeIds].some((locationSafeId) => locationSafeId !== safeId)) {
      throw new Error(`Image reference directory does not match its location ID: ${imagePath}`)
    }
    if (bundledPaths.has(imagePath)) continue

    const targetPath = path.resolve(root, safeId, `${pathHash}.${extension}`)
    let data
    try {
      data = await fs.readFile(targetPath)
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Image reference is missing from both the bundle and asset directory: ${imagePath}`)
      }
      throw error
    }
    if (data.length <= 0 || data.length > MAX_IMAGE_ASSET_BYTES || sha256(data) !== pathHash) {
      throw new Error(`Existing image reference does not match its content hash: ${imagePath}`)
    }
    assertImageType(data, { extension, mimeType: MIME_TYPE_BY_EXTENSION[extension] }, imagePath)
  }
}

async function planAssetWrites(assets, assetsDir) {
  const root = path.resolve(assetsDir)
  const writes = []
  let reused = 0
  for (const asset of assets) {
    const targetPath = path.resolve(root, asset.relativePath)
    const relativeTarget = path.relative(root, targetPath)
    if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
      throw new Error(`Image asset resolves outside the asset root: ${asset.path}`)
    }

    let existing
    try {
      existing = await fs.readFile(targetPath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (!existing) {
      writes.push({ ...asset, targetPath })
      continue
    }

    const existingHash = sha256(existing)
    if (existing.length !== asset.size || existingHash !== asset.sha256) {
      throw new Error(`Existing image asset does not match the bundle: ${relative(targetPath)}`)
    }
    assertImageType(existing, asset, relative(targetPath))
    reused += 1
  }
  return { writes, reused }
}

async function writeAssets(assetPlan) {
  const written = []
  try {
    for (const asset of assetPlan.writes) {
      await fs.mkdir(path.dirname(asset.targetPath), { recursive: true })
      await fs.writeFile(asset.targetPath, asset.data, { flag: 'wx' })
      written.push(asset.targetPath)
    }
  } catch (error) {
    await Promise.all(written.map((filePath) => fs.rm(filePath, { force: true })))
    throw error
  }
  return written
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(temporaryPath, 'wx')
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temporaryPath, filePath)
  } finally {
    if (handle) await handle.close().catch(() => {})
    await fs.rm(temporaryPath, { force: true })
  }
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

function mergeCategories(mapData, changes) {
  const categories = [...mapData.categories]
  const existingIds = new Set(categories.map((category) => String(category.id)))
  let added = 0
  let skippedIncomplete = 0

  for (const category of changes.categories || []) {
    const id = String(category.id || '').trim()
    if (!id || existingIds.has(id)) continue

    if (!category.label || !category.group) {
      skippedIncomplete += 1
      continue
    }

    categories.push(category)
    existingIds.add(id)
    added += 1
  }

  mapData.categories = categories
  return { added, skippedIncomplete }
}

function mergeLocations(mapData, changes) {
  const deleteIds = new Set((changes.deletedLocationIds || []).map((id) => String(id)))
  const before = mapData.locations.length
  const deletedExisting = mapData.locations.filter((location) => deleteIds.has(String(location.id))).length
  const locations = mapData.locations.filter((location) => !deleteIds.has(String(location.id)))
  const locationIndexes = new Map(locations.map((location, index) => [String(location.id), index]))
  let added = 0
  let updated = 0

  for (const location of changes.upsertLocations || []) {
    const id = String(location.id || '').trim()
    if (!id) throw new Error('Every upsert location must include an id.')

    if (locationIndexes.has(id)) {
      locations[locationIndexes.get(id)] = location
      updated += 1
    } else {
      locationIndexes.set(id, locations.length)
      locations.push(location)
      added += 1
    }
  }

  mapData.locations = locations

  return {
    before,
    deletedRequested: deleteIds.size,
    deletedExisting,
    upsertRequested: (changes.upsertLocations || []).length,
    updated,
    added,
    after: locations.length,
  }
}

function validateTypeReferences(mapData) {
  const categoryIds = new Set(mapData.categories.map((category) => String(category.id)))
  const missing = []

  for (const location of mapData.locations) {
    for (const type of location.types || []) {
      if (!categoryIds.has(String(type))) missing.push(`${location.id}:${type}`)
    }
  }

  return missing
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const mapData = await readJson(options.targetFile)
  const { changes, bundle } = await readChangesSource(options.sourceFile)

  validateMapData(mapData)
  validateChanges(changes)
  if (bundle && (changes.version !== 2
    || changes.type !== 'location-changes'
    || !Array.isArray(changes.imageAssets))) {
    throw new Error('ZIP bundle manifest must use location-changes version 2 with an imageAssets array.')
  }

  const sourceReplacementPaths = findReplacementCharacters(changes)
  if (sourceReplacementPaths.length > 0) {
    throw new Error(`Source file contains replacement characters:\n${sourceReplacementPaths.map((item) => `  ${item}`).join('\n')}`)
  }
  const assets = validateBundleAssets(changes, bundle)
  await validateExistingImageReferences(changes, assets, options.assetsDir)
  const assetPlan = await planAssetWrites(assets, options.assetsDir)

  const categoryStats = options.mergeCategories
    ? mergeCategories(mapData, changes)
    : { added: 0, skippedIncomplete: 0 }
  const locationStats = mergeLocations(mapData, changes)
  const missingTypeRefs = validateTypeReferences(mapData)
  const replacementPaths = findReplacementCharacters(mapData)

  if (missingTypeRefs.length > 0) {
    throw new Error(`Missing category references:\n${missingTypeRefs.map((item) => `  ${item}`).join('\n')}`)
  }
  if (replacementPaths.length > 0) {
    throw new Error(`Merged data contains replacement characters:\n${replacementPaths.map((item) => `  ${item}`).join('\n')}`)
  }

  const stats = {
    target: relative(options.targetFile),
    source: relative(options.sourceFile),
    dryRun: options.dryRun,
    categoriesAdded: categoryStats.added,
    categoriesSkippedIncomplete: categoryStats.skippedIncomplete,
    assetsWritten: assetPlan.writes.length,
    assetsReused: assetPlan.reused,
    ...locationStats,
  }

  if (!options.dryRun) {
    const writtenAssets = await writeAssets(assetPlan)
    try {
      await writeJsonAtomically(options.targetFile, mapData)
    } catch (error) {
      await Promise.allSettled(writtenAssets.map((filePath) => fs.rm(filePath, { force: true })))
      throw error
    }
  }

  console.log(JSON.stringify(stats, null, 2))
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
