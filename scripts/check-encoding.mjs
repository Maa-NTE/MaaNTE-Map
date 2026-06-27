import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_TARGETS = [
  'src',
  'scripts',
  'vite.config.js',
  'package.json',
]

function parseArgs(argv) {
  return argv.length ? argv : DEFAULT_TARGETS
}

async function* walk(targetPath) {
  const stat = await fs.stat(targetPath)
  if (stat.isDirectory()) {
    const entries = await fs.readdir(targetPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__pycache__') continue
      yield* walk(path.join(targetPath, entry.name))
    }
    return
  }
  if (stat.isFile()) yield targetPath
}

function shouldScan(filePath) {
  return /\.(json|js|mjs|cjs|ts|vue|css|html|md|py|ps1)$/i.test(filePath)
}

async function main() {
  const targets = parseArgs(process.argv.slice(2)).map((target) => path.resolve(target))
  const matches = []

  for (const target of targets) {
    for await (const filePath of walk(target)) {
      if (!shouldScan(filePath)) continue
      const content = await fs.readFile(filePath, 'utf8')
      const lines = content.split(/\r?\n/)
      lines.forEach((line, index) => {
        if (line.includes('\uFFFD')) {
          matches.push(`${path.relative(process.cwd(), filePath).replaceAll(path.sep, '/')}:${index + 1}`)
        }
      })
    }
  }

  if (matches.length) {
    console.error(`Found replacement characters (U+FFFD):\n${matches.map((item) => `  ${item}`).join('\n')}`)
    process.exit(1)
  }

  console.log('No replacement characters found.')
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
