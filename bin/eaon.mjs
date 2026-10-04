#!/usr/bin/env node
// The `eaon` command: runs the built CLI (npm run build:cli writes it).
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const built = fileURLToPath(new URL('../out/cli/eaon.mjs', import.meta.url))
if (!existsSync(built)) {
  console.error('eaon has not been built yet. Run `npm run build:cli` in the Eaon Desktop folder first.')
  process.exit(1)
}
await import(pathToFileURL(built).href)
