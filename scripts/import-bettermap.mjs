import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readMapData } from './lib/map-data-store.mjs'
import { locationFileName } from '../src/data/map-data-layout.js'
import { betterMapLocationSource } from '../src/data/location-source.js'

const KINDS = ['oracle-stone', 'gift-21', 'monster', 'city-crime']
const MAIN_LEVEL = 'XL_map_bigworld_test'
const hashId = (value) => createHash('sha256').update(value).digest('hex').slice(0, 20)
const normalizeLabel = (value) => String(value).replace(/\s+/g, '')
const readJson = async (file) => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''))

function parseArgs(args) {
  const options = {
    source: '', target: path.resolve('src/data/map-data.json'), output: path.resolve('output/imports/bettermap'),
    matchDistance: 1700, dryRun: false, categoryMap: '', authoritative: false,
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const next = () => {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`)
      return args[++index]
    }
    if (arg === '--target') options.target = path.resolve(next())
    else if (arg === '--output-dir') options.output = path.resolve(next())
    else if (arg === '--category-map') options.categoryMap = path.resolve(next())
    else if (arg === '--match-distance') options.matchDistance = Number(next())
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--authoritative') options.authoritative = true
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npm run import:bettermap -- <exports directory|index.json|category.json> [options]
  --target <file>          Map metadata file (default: src/data/map-data.json)
  --output-dir <dir>      Categorized change files (default: output/imports/bettermap)
  --match-distance <cm>   Match existing points of the same type (default: 1700)
  --category-map <file>   JSON mapping monster groupId to an existing category ID
  --authoritative         Replace imported category point sets with the game export
  --dry-run              Show statistics without writing files

Matching preserves existing IDs, names, screenshots and notes. Ambiguous matches are skipped by default.
Authoritative mode reuses nearest old records one-to-one and removes unmatched old points in imported categories.
Only main-world points are imported. Categories absent from the export remain unchanged.`)
      process.exit(0)
    } else if (!arg.startsWith('-') && !options.source) options.source = path.resolve(arg)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!options.source) throw new Error('Specify a BetterMap export directory or category JSON file.')
  if (!Number.isFinite(options.matchDistance) || options.matchDistance < 0) throw new Error('Invalid --match-distance.')
  return options
}

function validateHeader(document) {
  if (document?.schemaVersion !== 1 || document.source !== 'b1ank.better-map'
    || document.coordinateSystem !== 'ue-world-centimeters') {
    throw new Error('Expected a BetterMap v1 export in UE world centimeters.')
  }
}

async function readExport(source) {
  const sourceFile = (await fs.stat(source)).isDirectory() ? path.join(source, 'index.json') : source
  const document = await readJson(sourceFile)
  validateHeader(document)
  if (!Array.isArray(document.files)) return { categories: [document], unavailable: [] }
  if (!document.datasets || KINDS.some((kind) => typeof document.datasets[kind] !== 'boolean')) {
    throw new Error('Invalid BetterMap dataset availability index.')
  }
  const seen = new Set()
  const categories = []
  for (const entry of document.files) {
    if (typeof entry.path !== 'string' || !/^[a-z0-9-]+\.json$/.test(entry.path)
      || entry.path === 'index.json' || seen.has(entry.path)) throw new Error(`Invalid or duplicate category path: ${entry.path}`)
    seen.add(entry.path)
    const category = await readJson(path.join(path.dirname(sourceFile), entry.path))
    validateHeader(category)
    if (!document.datasets[category.kind] || entry.kind !== category.kind || entry.groupId !== category.groupId
      || entry.count !== category.points?.length) throw new Error(`Category does not match index: ${entry.path}`)
    categories.push(category)
  }
  return { categories, unavailable: KINDS.filter((kind) => !document.datasets[kind]) }
}

function resolveCategory(source, categories, overrides, defaults) {
  if (source.kind !== 'monster') {
    const defaults = {
      'oracle-stone': { id: 'oracle-stone', group: '探索度', label: '谕石', color: '#ffd27d' },
      'gift-21': { id: 'gift-21', group: '探索度', label: '21的赠礼', color: '#ffd27d' },
      'city-crime': { id: 'city-crime', group: '城市事件', label: '城市违规行径', color: '#e8a6ff', iconUrl: '/icons/city-crime.png' },
    }
    const fallback = defaults[source.kind]
    return categories.find((category) => category.id === fallback.id) || { ...fallback, icon: '✦', isDefault: false }
  }
  if (Object.hasOwn(overrides, source.groupId)) {
    const category = categories.find((item) => item.id === overrides[source.groupId])
    if (!category) throw new Error(`Unknown override category: ${overrides[source.groupId]}`)
    return category
  }
  const mapping = defaults[source.groupId]
  const known = categories.find((category) => category.id === mapping?.id)
  if (known) return known
  const matches = categories.filter((category) => category.group === '怪物'
    && normalizeLabel(category.label) === normalizeLabel(source.name))
  if (matches.length > 1) throw new Error(`Ambiguous monster category: ${source.name}; use --category-map.`)
  return matches[0] || {
    id: mapping?.id || `bettermap-monster-${hashId(source.groupId)}`, group: '怪物', label: source.name,
    ...(mapping?.iconUrl ? { iconUrl: mapping.iconUrl } : {}),
    icon: '◆', color: '#ff8a70', isDefault: false,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const { categories: sources, unavailable } = await readExport(options.source)
  const mapData = readMapData(options.target)
  const overrides = options.categoryMap ? await readJson(options.categoryMap) : {}
  const defaultCategories = await readJson(path.resolve('src/data/bettermap-category-map.json'))
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Invalid category map.')
  const categories = [...mapData.categories]
  const byId = new Map(mapData.locations.map((location) => [location.id, location]))
  const bySource = new Map()
  for (const location of mapData.locations) {
    if (!location.betterMapId) continue
    if (bySource.has(location.betterMapId)) throw new Error(`Duplicate BetterMap identity: ${location.betterMapId}`)
    bySource.set(location.betterMapId, location)
  }
  const points = []
  const sourceIds = new Set()
  const sourceCategories = new Map()
  const stats = { dryRun: options.dryRun, authoritative: options.authoritative, unavailable, skippedOtherLevels: 0,
    added: 0, updated: 0, deleted: 0, retainedOtherTypes: 0, ambiguous: [], files: [] }
  for (const source of sources) {
    validateHeader(source)
    if (!KINDS.includes(source.kind) || !Array.isArray(source.points) || typeof source.name !== 'string' || !source.name
      || (source.kind === 'monster' && (typeof source.groupId !== 'string' || !source.groupId))) {
      throw new Error('Invalid BetterMap category.')
    }
    const category = resolveCategory(source, categories, overrides, defaultCategories)
    locationFileName(category.id)
    sourceCategories.set(category.id, category)
    if (!categories.some((item) => item.id === category.id)) {
      if (!category.iconUrl && !category.icon?.startsWith('/')) {
        throw new Error(`New category ${source.name} needs an icon. Add its id and iconUrl to src/data/bettermap-category-map.json.`)
      }
      categories.push(category)
    }
    for (const point of source.points) {
      if (typeof point?.id !== 'string' || !point.id || sourceIds.has(point.id)
        || typeof point.rowId !== 'string' || !point.rowId || typeof point.level !== 'string'
        || ![point.x, point.y, point.z].every((axis) => Number.isFinite(axis) && Math.abs(axis) < 1e8)) {
        throw new Error(`Invalid or duplicate BetterMap point: ${point?.id}`)
      }
      sourceIds.add(point.id)
      if (point.level !== MAIN_LEVEL) { stats.skippedOtherLevels += 1; continue }
      const id = `bettermap-${hashId(point.id)}`
      const exact = bySource.get(point.id) || byId.get(id)
      if (exact && (!exact.types.includes(category.id) || (exact.betterMapId && exact.betterMapId !== point.id))) {
        throw new Error(`Conflicting existing point identity: ${point.id}`)
      }
      const candidates = exact ? [exact] : mapData.locations.filter((location) => !location.betterMapId
        && location.types.includes(category.id)
        && Math.hypot(location.x - point.x, location.y - point.y) <= options.matchDistance
        && (!Number.isFinite(location.z) || Math.abs(location.z - point.z) <= options.matchDistance))
      points.push({ point, category, id, candidates, exact, kind: source.kind, groupId: source.groupId })
    }
  }
  if (options.authoritative) {
    const used = new Set(points.filter((entry) => entry.exact).map((entry) => entry.exact.id))
    const assigned = new Map()
    const edges = points.filter((entry) => !entry.exact).flatMap((entry) => entry.candidates.map((candidate) => ({
      entry, candidate, distance: Math.hypot(entry.point.x - candidate.x, entry.point.y - candidate.y),
    }))).sort((left, right) => left.distance - right.distance
      || left.entry.point.id.localeCompare(right.entry.point.id) || left.candidate.id.localeCompare(right.candidate.id))
    for (const { entry, candidate } of edges) {
      if (used.has(candidate.id) || assigned.has(entry)) continue
      used.add(candidate.id)
      assigned.set(entry, candidate)
    }
    for (const entry of points) entry.candidates = entry.exact ? [entry.exact] : assigned.has(entry) ? [assigned.get(entry)] : []
  }
  // Resolve the batch first: two source points must never overwrite one old point.
  const claims = new Map()
  for (const entry of points) {
    if (entry.candidates.length !== 1) continue
    const id = entry.candidates[0].id
    claims.set(id, (claims.get(id) || 0) + 1)
  }
  const changes = new Map()
  const retainedIds = new Set()
  const categoryChanges = (category) => {
    if (!changes.has(category.id)) changes.set(category.id, {
      version: 1, type: 'location-changes', categories: [category], upsertLocations: [], deletedLocationIds: [],
    })
    return changes.get(category.id)
  }
  for (const { point, category, id, candidates, kind, groupId } of points) {
    if (candidates.length > 1 || (candidates.length === 1 && claims.get(candidates[0].id) > 1)) {
      stats.ambiguous.push({ sourceId: point.id, candidateIds: candidates.map((item) => item.id) })
      continue
    }
    const existing = candidates[0]
    const location = {
      ...(existing || {
        id, name: `${category.label} · ${point.rowId}`, types: [category.id], district: '全地图',
        description: category.id === 'city-crime' ? '城市违规事件可能发生的位置，不代表事件正在发生。' : '',
        tags: [], images: [],
      }),
      x: point.x, y: point.y, z: point.z, betterMapId: point.id,
      source: betterMapLocationSource(kind, point, groupId),
    }
    if (options.authoritative) location.types = [category.id, ...location.types.filter((type) => !sourceCategories.has(type))]
    retainedIds.add(location.id)
    categoryChanges(category).upsertLocations.push(location)
    stats[existing ? 'updated' : 'added'] += 1
  }
  if (options.authoritative) {
    for (const location of mapData.locations) {
      if (retainedIds.has(location.id)) continue
      const importedType = location.types.find((type) => sourceCategories.has(type))
      if (!importedType) continue
      const changesForCategory = categoryChanges(sourceCategories.get(importedType))
      const types = location.types.filter((type) => !sourceCategories.has(type))
      if (types.length) {
        const remaining = { ...location, types }
        delete remaining.betterMapId
        changesForCategory.upsertLocations.push(remaining)
        stats.retainedOtherTypes += 1
      } else {
        changesForCategory.deletedLocationIds.push(location.id)
        stats.deleted += 1
      }
    }
  }
  const files = [...changes.keys()].sort().map((id) => `${id}.json`)
  stats.files = files.map((file) => path.join(options.output, file))
  if (!options.dryRun) {
    await fs.mkdir(options.output, { recursive: true })
    for (const [id, change] of changes) {
      await fs.writeFile(path.join(options.output, `${id}.json`), `${JSON.stringify(change, null, 2)}\n`, 'utf8')
    }
    await fs.writeFile(path.join(options.output, 'index.json'), `${JSON.stringify({
      version: 1, type: 'location-changes-index', files,
    }, null, 2)}\n`, 'utf8')
  }
  console.log(JSON.stringify(stats, null, 2))
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
