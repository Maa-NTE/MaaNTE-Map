// Multi-type locations live only in the file for their first type.
export function locationFileName(type) {
  if (typeof type !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(type)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(type)) {
    throw new Error(`Invalid location category ID: ${type}`)
  }
  return `locations/${type}.json`
}

export function validateLocationFiles(files) {
  if (!Array.isArray(files) || new Set(files).size !== files.length
    || files.some((file) => typeof file !== 'string'
      || !/^locations\/[a-z0-9][a-z0-9_-]{0,79}\.json$/.test(file))) {
    throw new Error('Invalid locationFiles index.')
  }
}

export function assembleMapData(metadata, files) {
  if (!metadata.locationFiles) return metadata
  validateLocationFiles(metadata.locationFiles)
  if (metadata.locations !== undefined) throw new Error('Indexed map metadata must not contain locations.')
  const { locationFiles, ...data } = metadata
  const ids = new Set()
  data.locations = locationFiles.flatMap((file) => {
    const locations = files.get(file)
    if (!Array.isArray(locations)) throw new Error(`Missing location array: ${file}`)
    for (const location of locations) {
      if (!location?.id || ids.has(location.id)) throw new Error(`Duplicate or missing location ID in ${file}: ${location?.id}`)
      if (locationFileName(location.types?.[0]) !== file) throw new Error(`Location ${location.id} is in the wrong category file: ${file}`)
      ids.add(location.id)
    }
    return locations
  })
  return data
}

export function partitionMapData(data, previousFiles = []) {
  validateLocationFiles(previousFiles)
  const files = new Map(previousFiles.map((file) => [file, []]))
  for (const category of data.categories) files.set(locationFileName(category.id), [])
  const ids = new Set()
  const knownTypes = new Set(data.categories.map((category) => category.id))
  for (const location of data.locations) {
    if (!location?.id || ids.has(location.id)) throw new Error(`Duplicate or missing location ID: ${location?.id}`)
    if (!Array.isArray(location.types) || !location.types.length || location.types.some((type) => !knownTypes.has(type))) {
      throw new Error(`Unknown or missing category for location: ${location.id}`)
    }
    ids.add(location.id)
    const file = locationFileName(location.types[0])
    files.get(file).push(location)
  }
  const { locations, locationFiles, ...metadata } = data
  metadata.locationFiles = [...files.keys()].sort()
  return { metadata, files }
}
