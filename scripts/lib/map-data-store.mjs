import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assembleMapData, partitionMapData, validateLocationFiles } from '../../src/data/map-data-layout.js'

export function readMapData(filePath) {
  const metadata = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  if (!metadata.locationFiles) return metadata
  validateLocationFiles(metadata.locationFiles)
  const files = new Map(metadata.locationFiles.map((file) => [file,
    JSON.parse(fs.readFileSync(path.join(path.dirname(filePath), file), 'utf8').replace(/^\uFEFF/, '')),
  ]))
  return assembleMapData(metadata, files)
}

function replaceTextAtomically(filePath, document) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`
  let descriptor
  try {
    descriptor = fs.openSync(temporaryPath, 'wx')
    fs.writeFileSync(descriptor, document, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporaryPath, filePath)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    fs.rmSync(temporaryPath, { force: true })
  }
}

export function writeMapData(filePath, data, { split = false } = {}) {
  const previousText = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null
  const previous = previousText === null ? {} : JSON.parse(previousText.replace(/^\uFEFF/, ''))
  let documents
  // Standalone --target files remain supported for existing import bundles and fixtures.
  if (!split && !previous.locationFiles) {
    documents = [[filePath, data]]
  } else {
    const { metadata, files } = partitionMapData(data, previous.locationFiles || [])
    documents = [...files].map(([file, locations]) => [path.join(path.dirname(filePath), file), locations])
    documents.push([filePath, metadata])
  }
  const pending = documents.map(([target, value]) => ({
    target, document: `${JSON.stringify(value, null, 2)}\n`,
    original: target === filePath ? previousText : fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null,
  })).filter((entry) => entry.document !== entry.original)
  const completed = []
  try {
    for (const entry of pending) {
      replaceTextAtomically(entry.target, entry.document)
      completed.push(entry)
    }
  } catch (error) {
    // Keep prior bytes in memory so a failed batch cannot leave partial category edits.
    const restoreErrors = []
    for (const entry of completed.reverse()) {
      try {
        if (entry.original === null) fs.rmSync(entry.target)
        else replaceTextAtomically(entry.target, entry.original)
      } catch (restoreError) { restoreErrors.push(restoreError) }
    }
    if (restoreErrors.length) {
      const failure = new AggregateError([error, ...restoreErrors], 'Could not fully restore category files after a write failure.')
      failure.mapDataMayHaveChanged = true
      throw failure
    }
    throw error
  }
}
