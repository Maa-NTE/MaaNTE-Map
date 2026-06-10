import fs from 'node:fs/promises'
import path from 'node:path'

const SOURCE_URL = 'https://zeroluck.gg/nte/interactive-map/'
const LOCAL_DATA_FILE = path.resolve('src/data/map-data.json')
const DEFAULT_OUTPUT_FILE = path.resolve('output/imports/nte-location-changes.json')
const DEFAULT_TERMS_FILE = path.resolve('src/data/import-terms/nte-map-terms.json')
const DEFAULT_ASSETS_DIR = path.resolve('public/icons/imported/nte')
const DEFAULT_ASSETS_PUBLIC_PATH = '/icons/imported/nte'
const DEFAULT_GROUP = '导入点位'
const POSITION_SCALE = 22
const DUPLICATE_DISTANCE = 1.25

const CATEGORY_COLORS = [
  '#8adfd6',
  '#ffd27d',
  '#e8a6ff',
  '#ff8a70',
  '#87a9ff',
  '#8fdf8a',
  '#f09cc3',
  '#9cc7f0',
]

const EXISTING_CATEGORY_IDS = {
  'oracle-stone': 'oracle-stone',
  currencies: 'gift-21',
  'quest-start': 'sidequest',
  'anomaly-vision': 'anomaly',
}

const DUPLICATE_TYPE_HINTS = {
  'oracle-stone': ['oracle-stone'],
  currencies: ['gift-21'],
  'fast-travel': ['phonebooth', 'tower', 'pinkpaw', 'witch'],
  'quest-start': ['sidequest'],
  'anomaly-vision': ['anomaly'],
  collectible: ['checkin', 'figurine', 'furniture', 'category-010', 'sundries'],
  'stealable-loot': ['street-justice', 'magician-gift', 'category-010', 'sundries'],
  monsters: [
    'category-014',
    'feather-doll',
    'demon-blade',
    'category-017',
    'cardboard-castle',
    'sunshine-doll',
    'fake-phonebooth',
    'record-spirit',
    'vending-spirit',
    'dismantler',
    'possessed',
    'sad-bear',
    'wind-cave',
    'rain-man',
    'eternal-lamp',
    'lost',
    'nonos',
    'mask-kite',
    'dream',
    'fish-banner',
    'pop',
    'cotton',
    'towboat',
    'hug-vine',
  ],
}

function parseArgs(argv) {
  const options = {
    categories: [],
    all: false,
    listCategories: false,
    outputFile: DEFAULT_OUTPUT_FILE,
    termsFile: DEFAULT_TERMS_FILE,
    termsInputFile: '',
    assetsDir: DEFAULT_ASSETS_DIR,
    assetsPublicPath: DEFAULT_ASSETS_PUBLIC_PATH,
    group: DEFAULT_GROUP,
    includeDuplicates: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[++index] || ''

    if (arg === '--all') options.all = true
    else if (arg === '--list-categories') options.listCategories = true
    else if (arg === '--include-duplicates') options.includeDuplicates = true
    else if (arg === '--categories') options.categories = splitList(next())
    else if (arg.startsWith('--categories=')) options.categories = splitList(arg.slice('--categories='.length))
    else if (arg === '--output') options.outputFile = path.resolve(next())
    else if (arg.startsWith('--output=')) options.outputFile = path.resolve(arg.slice('--output='.length))
    else if (arg === '--terms') options.termsFile = path.resolve(next())
    else if (arg.startsWith('--terms=')) options.termsFile = path.resolve(arg.slice('--terms='.length))
    else if (arg === '--terms-input') options.termsInputFile = path.resolve(next())
    else if (arg.startsWith('--terms-input=')) options.termsInputFile = path.resolve(arg.slice('--terms-input='.length))
    else if (arg === '--assets-dir') options.assetsDir = path.resolve(next())
    else if (arg.startsWith('--assets-dir=')) options.assetsDir = path.resolve(arg.slice('--assets-dir='.length))
    else if (arg === '--assets-public-path') options.assetsPublicPath = normalizePublicPath(next())
    else if (arg.startsWith('--assets-public-path=')) options.assetsPublicPath = normalizePublicPath(arg.slice('--assets-public-path='.length))
    else if (arg === '--group') options.group = next() || DEFAULT_GROUP
    else if (arg.startsWith('--group=')) options.group = arg.slice('--group='.length) || DEFAULT_GROUP
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizePublicPath(value) {
  const pathValue = String(value || '').trim() || DEFAULT_ASSETS_PUBLIC_PATH
  return `/${pathValue.replace(/^\/+|\/+$/g, '')}`
}

function printHelp() {
  console.log(`Usage:
  npm run import:zeroluck -- --list-categories
  npm run import:zeroluck -- --categories taxi,locker
  npm run import:zeroluck -- --categories "Fast Travel,Taxi" --terms-input src/data/import-terms/nte-map-terms.json

Options:
  --categories <ids-or-labels>       Comma-separated source category ids or labels to import.
  --all                             Import every source category.
  --list-categories                 Print available source categories and exit.
  --output <file>                   Write a location-changes JSON file. Default: ${relative(DEFAULT_OUTPUT_FILE)}
  --terms <file>                    Write a translation term table. Default: ${relative(DEFAULT_TERMS_FILE)}
  --terms-input <file>              Reuse completed translations from a previous term table.
  --assets-dir <dir>                Download icon assets here. Default: ${relative(DEFAULT_ASSETS_DIR)}
  --assets-public-path <path>       Public URL path for downloaded assets. Default: ${DEFAULT_ASSETS_PUBLIC_PATH}
  --group <name>                    Group name for new imported categories. Default: ${DEFAULT_GROUP}
  --include-duplicates              Do not skip points close to existing local points.
`)
}

function relative(filePath) {
  return path.relative(process.cwd(), filePath).replaceAll(path.sep, '/')
}

function slugify(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'item'
}

function uniqueId(base, usedIds) {
  let id = base
  let index = 2
  while (usedIds.has(id)) {
    id = `${base}-${index}`
    index += 1
  }
  usedIds.add(id)
  return id
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

async function readInitialPayload() {
  const response = await fetch(SOURCE_URL)
  if (!response.ok) {
    throw new Error(`Failed to load ${SOURCE_URL}: ${response.status}`)
  }

  const html = await response.text()
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
  if (!match) {
    throw new Error('Could not find __NEXT_DATA__ in source map page')
  }

  return JSON.parse(match[1]).props?.pageProps?.initialPayload
}

async function readCategoryMarkers(payload, categoryId) {
  const baseUrl = String(payload.meta?.categoriesBaseUrl || '').trim()
  if (!baseUrl) {
    throw new Error('Source payload does not expose categoriesBaseUrl')
  }

  const url = new URL(`${baseUrl}/${encodeURIComponent(categoryId)}.en.json`, SOURCE_URL)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to load ${url.href}: ${response.status}`)
  }

  const data = await response.json()
  return Array.isArray(data.markers) ? data.markers : []
}

function selectCategories(payload, options) {
  const categories = payload.categories || []
  if (options.all) return categories

  const requested = new Set(options.categories.map((item) => item.toLowerCase()))
  return categories.filter((category) => (
    requested.has(String(category.id || '').toLowerCase())
    || requested.has(String(category.label || '').toLowerCase())
    || requested.has(String(category.singularLabel || '').toLowerCase())
  ))
}

function listCategories(payload) {
  console.log('Available categories:')
  for (const category of payload.categories || []) {
    console.log(`- ${category.id}: ${category.label} (${category.total ?? 0})`)
  }
}

function createTermStore(existingTermsPayload) {
  const byKey = new Map()
  const terms = []

  for (const term of existingTermsPayload?.terms || []) {
    if (term?.key) byKey.set(term.key, term)
  }

  function add(kind, keyParts, source, context = {}) {
    const sourceText = String(source || '').trim()
    if (!sourceText) return ''

    const key = `${kind}:${keyParts.map(slugify).join(':')}`
    const existing = byKey.get(key)
    const target = String(existing?.target || existing?.translation || '').trim()
    const term = {
      key,
      kind,
      source: sourceText,
      target,
      ...context,
    }
    terms.push(term)
    byKey.set(key, term)
    return target || sourceText
  }

  return {
    add,
    payload() {
      return {
        version: 1,
        type: 'nte-map-terms',
        instructions: 'Fill target with the translated text, then pass this file back with --terms-input.',
        terms: [...new Map(terms.map((term) => [term.key, term])).values()]
          .sort((a, b) => a.kind.localeCompare(b.kind) || a.source.localeCompare(b.source)),
      }
    },
  }
}

function localPosition(marker) {
  const x = Number(marker?.position?.map?.x)
  const y = Number(marker?.position?.map?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null

  return {
    lat: Number((y / POSITION_SCALE).toFixed(6)),
    lng: Number((x / POSITION_SCALE).toFixed(6)),
  }
}

function createDuplicateLookup(locations) {
  const byType = new Map()
  for (const location of locations) {
    const lat = Number(location.lat)
    const lng = Number(location.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue

    for (const type of location.types || []) {
      if (!byType.has(type)) byType.set(type, [])
      byType.get(type).push({ lat, lng })
    }
  }

  return byType
}

function isDuplicate(position, categoryId, duplicateLookup) {
  const candidateTypes = DUPLICATE_TYPE_HINTS[categoryId] || []
  if (!candidateTypes.length) return false

  for (const type of candidateTypes) {
    for (const existing of duplicateLookup.get(type) || []) {
      const distance = Math.hypot(existing.lat - position.lat, existing.lng - position.lng)
      if (distance <= DUPLICATE_DISTANCE) return true
    }
  }

  return false
}

function localCategoryId(sourceCategoryId, localCategoryIds) {
  const mapped = EXISTING_CATEGORY_IDS[sourceCategoryId]
  if (mapped && localCategoryIds.has(mapped)) return mapped

  const sourceId = slugify(sourceCategoryId)
  return localCategoryIds.has(sourceId) ? `imported-${sourceId}` : sourceId
}

function isExistingCategoryReference(sourceCategoryId, localCategoryIds) {
  const mapped = EXISTING_CATEGORY_IDS[sourceCategoryId]
  return Boolean(mapped && localCategoryIds.has(mapped))
}

async function downloadAsset(url, assetsDir, assetsPublicPath, stem) {
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) return url

  const parsed = new URL(url)
  const extension = path.extname(parsed.pathname).toLowerCase() || '.png'
  const filename = `${slugify(stem)}${extension}`
  const outputPath = path.join(assetsDir, filename)
  await fs.mkdir(assetsDir, { recursive: true })

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download asset ${url}: ${response.status}`)
  }

  await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()))
  return `${assetsPublicPath}/${filename}`
}

function buildDescription(marker, categoryLabel, regionLabel, termStore) {
  const parts = [categoryLabel, regionLabel]
  if (marker.entityId) parts.push(`entity: ${marker.entityId}`)
  if (marker.subtypeKey) parts.push(`subtype: ${termStore.add('subtype', [marker.subtypeKey], marker.subtypeKey)}`)
  if (marker.grade) parts.push(`grade: ${termStore.add('grade', [marker.grade], marker.grade)}`)
  if (Number.isFinite(Number(marker.currencyRewardAmount))) parts.push(`reward: ${marker.currencyRewardAmount}`)

  const storeItems = marker.storeContent?.items
    ?.slice(0, 8)
    .map((item) => {
      const name = termStore.add('store-item', [item.name], item.name)
      return `${name}${Number.isFinite(Number(item.price)) ? ` (${item.price})` : ''}`
    })
    .join(', ')

  if (storeItems) parts.push(`store: ${storeItems}`)
  return parts.filter(Boolean).join(' | ')
}

function buildLocation(marker, category, context) {
  const position = localPosition(marker)
  if (!position) return null

  const {
    localCategoryId,
    regionById,
    usedLocationIds,
    termStore,
    categoryLabel,
  } = context
  const sourceRegionLabel = regionById.get(marker.regionId)?.label || marker.regionId || 'Unknown region'
  const regionLabel = termStore.add('region', [marker.regionId || sourceRegionLabel], sourceRegionLabel, {
    sourceId: marker.regionId || '',
  })
  const title = termStore.add('marker-title', [category.id, marker.title || marker.id], marker.title || category.singularLabel || category.label || marker.id, {
    categoryId: category.id,
    sourceId: marker.id,
  })
  const sourceId = slugify(marker.id)
  const localId = uniqueId(`${slugify(localCategoryId)}-${sourceId}`.slice(0, 96), usedLocationIds)
  const tags = [
    categoryLabel,
    regionLabel,
    marker.entityId,
    marker.subtypeKey ? termStore.add('subtype', [marker.subtypeKey], marker.subtypeKey) : '',
    marker.questType ? termStore.add('quest-type', [marker.questType], marker.questType) : '',
    marker.grade ? termStore.add('grade', [marker.grade], marker.grade) : '',
  ].filter(Boolean)

  return {
    id: localId,
    name: title,
    types: [localCategoryId],
    district: regionLabel,
    ...position,
    description: buildDescription(marker, categoryLabel, regionLabel, termStore),
    tags: [...new Set(tags.map(String))],
    images: [],
  }
}

async function buildImport(options) {
  const localData = await readJsonIfExists(LOCAL_DATA_FILE, { categories: [], locations: [] })
  const payload = await readInitialPayload()
  if (!payload?.categories?.length) {
    throw new Error('Source payload does not contain categories')
  }

  if (options.listCategories || (!options.all && !options.categories.length)) {
    listCategories(payload)
    if (!options.listCategories) {
      console.log('\nPass --categories <ids> or --all to generate an import file.')
    }
    return null
  }

  const selectedCategories = selectCategories(payload, options)
  if (!selectedCategories.length) {
    throw new Error(`No source categories matched: ${options.categories.join(', ')}`)
  }

  const missing = options.categories.filter((requested) => !selectedCategories.some((category) => (
    category.id.toLowerCase() === requested.toLowerCase()
    || category.label.toLowerCase() === requested.toLowerCase()
    || String(category.singularLabel || '').toLowerCase() === requested.toLowerCase()
  )))
  if (missing.length) {
    throw new Error(`Unknown source categories: ${missing.join(', ')}`)
  }

  const existingTerms = await readJsonIfExists(options.termsInputFile || options.termsFile, null)
  const termStore = createTermStore(existingTerms)
  const duplicateLookup = createDuplicateLookup(localData.locations || [])
  const localCategoryIds = new Set((localData.categories || []).map((category) => category.id))
  const usedLocationIds = new Set((localData.locations || []).map((location) => location.id))
  const regionById = new Map((payload.regions || []).map((region) => [region.id, region]))
  const categories = []
  const upsertLocations = []
  const skippedDuplicates = []
  const categoryCounts = new Map()

  for (const category of selectedCategories) {
    const categoryId = localCategoryId(category.id, localCategoryIds)
    const categoryLabel = termStore.add('category', [category.id, 'label'], category.label, {
      sourceId: category.id,
    })
    termStore.add('category-singular', [category.id, 'singular'], category.singularLabel || category.label, {
      sourceId: category.id,
    })

    if (!isExistingCategoryReference(category.id, localCategoryIds)) {
      const iconUrl = await downloadAsset(
        category.iconUrl,
        options.assetsDir,
        options.assetsPublicPath,
        `category-${category.id}`,
      )
      categories.push({
        id: categoryId,
        group: options.group,
        label: categoryLabel,
        icon: '·',
        ...(iconUrl ? { iconUrl } : {}),
        color: CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length],
        isDefault: false,
      })
    }

    const markers = await readCategoryMarkers(payload, category.id)
    for (const marker of markers) {
      const position = localPosition(marker)
      if (!position) continue
      if (!options.includeDuplicates && isDuplicate(position, category.id, duplicateLookup)) {
        skippedDuplicates.push(marker.id)
        continue
      }

      const location = buildLocation(marker, category, {
        localCategoryId: categoryId,
        regionById,
        usedLocationIds,
        termStore,
        categoryLabel,
      })
      if (!location) continue
      upsertLocations.push(location)
      categoryCounts.set(category.id, (categoryCounts.get(category.id) || 0) + 1)
    }
  }

  const importPayload = {
    version: 1,
    type: 'location-changes',
    categories,
    upsertLocations,
  }

  const termsPayload = termStore.payload()
  await fs.mkdir(path.dirname(options.outputFile), { recursive: true })
  await fs.writeFile(options.outputFile, `${JSON.stringify(importPayload, null, 2)}\n`, 'utf8')
  await fs.mkdir(path.dirname(options.termsFile), { recursive: true })
  await fs.writeFile(options.termsFile, `${JSON.stringify(termsPayload, null, 2)}\n`, 'utf8')

  return {
    selectedCategories,
    categoryCounts,
    skippedDuplicates,
    outputFile: options.outputFile,
    termsFile: options.termsFile,
    assetsDir: options.assetsDir,
    upsertCount: upsertLocations.length,
    categoryCount: categories.length,
  }
}

const options = parseArgs(process.argv.slice(2))
buildImport(options)
  .then((result) => {
    if (!result) return
    console.log(`Wrote ${result.upsertCount} locations and ${result.categoryCount} new categories`)
    console.log(`Skipped ${result.skippedDuplicates.length} likely duplicate locations`)
    console.log(`Import file: ${relative(result.outputFile)}`)
    console.log(`Terms file: ${relative(result.termsFile)}`)
    console.log(`Assets dir: ${relative(result.assetsDir)}`)
    console.log('Imported counts:')
    for (const category of result.selectedCategories) {
      console.log(`- ${category.id}: ${result.categoryCounts.get(category.id) || 0}`)
    }
  })
  .catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
