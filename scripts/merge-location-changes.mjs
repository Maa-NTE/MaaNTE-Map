import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_TARGET_FILE = path.resolve('src/data/map-data.json')

function parseArgs(argv) {
  const options = {
    sourceFile: '',
    targetFile: DEFAULT_TARGET_FILE,
    dryRun: false,
    mergeCategories: true,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[++index] || ''

    if (arg === '--target') options.targetFile = path.resolve(next())
    else if (arg.startsWith('--target=')) options.targetFile = path.resolve(arg.slice('--target='.length))
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
    throw new Error('Missing source location-changes JSON file.')
  }

  return options
}

function printHelp() {
  console.log(`Usage:
  npm run merge:locations -- <location-changes.json>
  npm run merge:locations -- C:/Users/owo/Downloads/点位.json
  npm run merge:locations -- output/imports/nte-location-changes.json --dry-run

Options:
  --target <file>             Target map data file. Default: ${relative(DEFAULT_TARGET_FILE)}
  --dry-run                   Print merge statistics without writing the target file.
  --no-merge-categories       Do not append new category definitions from the source file.
`)
}

function relative(filePath) {
  return path.relative(process.cwd(), filePath).replaceAll(path.sep, '/')
}

async function readJson(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return JSON.parse(content.replace(/^\uFEFF/, ''))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${relative(filePath)}: ${error.message}`)
    }
    throw error
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
  if (changes.type && changes.type !== 'location-changes') {
    throw new Error(`Unsupported changes type: ${changes.type}`)
  }

  if (changes.categories !== undefined) assertArray(changes.categories, 'source categories')
  if (changes.upsertLocations !== undefined) assertArray(changes.upsertLocations, 'source upsertLocations')
  if (changes.deletedLocationIds !== undefined) assertArray(changes.deletedLocationIds, 'source deletedLocationIds')
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
  const changes = await readJson(options.sourceFile)

  validateMapData(mapData)
  validateChanges(changes)

  const categoryStats = options.mergeCategories
    ? mergeCategories(mapData, changes)
    : { added: 0, skippedIncomplete: 0 }
  const locationStats = mergeLocations(mapData, changes)
  const missingTypeRefs = validateTypeReferences(mapData)

  if (missingTypeRefs.length > 0) {
    throw new Error(`Missing category references:\n${missingTypeRefs.map((item) => `  ${item}`).join('\n')}`)
  }

  const stats = {
    target: relative(options.targetFile),
    source: relative(options.sourceFile),
    dryRun: options.dryRun,
    categoriesAdded: categoryStats.added,
    categoriesSkippedIncomplete: categoryStats.skippedIncomplete,
    ...locationStats,
  }

  if (!options.dryRun) {
    await fs.writeFile(options.targetFile, `${JSON.stringify(mapData, null, 2)}\n`, 'utf8')
  }

  console.log(JSON.stringify(stats, null, 2))
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
