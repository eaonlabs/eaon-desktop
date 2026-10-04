#!/usr/bin/env node
/**
 * Builds the Eaon CLI (cli/) into one file, out/cli/eaon.mjs (the `eaon` command).
 *
 * The CLI runs the desktop app's main-process code under plain Node, so it
 * is bundled the way the main-process tests are (scripts/test-main.mjs):
 * `electron` aliased to a stand-in (cli/src/runtime/electron.ts), `@shared`
 * and `@main` to the app's sources. Dependencies are bundled too, so the
 * output runs anywhere with Node 22, except the few that are native or only
 * load inside Electron — nothing the CLI reaches imports those.
 *
 * The npm package (`@eaonlabs/cli`) is described by cli/package.json, which also
 * gives the CLI its name and version. `--package` assembles what gets
 * published in out/cli-package: the bundle without its source map, that
 * manifest, the README and the licence files.
 *
 *   node scripts/build-cli.mjs              build
 *   node scripts/build-cli.mjs --watch      rebuild on change
 *   node scripts/build-cli.mjs --package    build, then assemble out/cli-package
 */
import { build, context } from 'esbuild'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'cli', 'package.json'), 'utf8'))
const outfile = join(root, 'out', 'cli', 'eaon.mjs')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [join(root, 'cli/src/main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'linked',
  alias: {
    electron: join(root, 'cli/src/runtime/electron.ts'),
    '@shared': join(root, 'src/shared'),
    '@main': join(root, 'src/main')
  },
  external: ['node-pty', 'betterwright', 'betterwright/*', 'baileys', 'electron-updater', '@xterm/*', 'bufferutil', 'utf-8-validate'],
  define: { __EAON_CLI_VERSION__: JSON.stringify(pkg.version), __EAON_CLI_PACKAGE__: JSON.stringify(pkg.name) },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
  },
  loader: { '.md': 'text' },
  logLevel: 'warning'
}

if (process.argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('Watching cli/ and src/ for changes…')
} else {
  await build(options)
  chmodSync(outfile, 0o755)
  console.log(`Built ${outfile.replace(root + '/', '')} (${pkg.name} ${pkg.version})`)
  if (process.argv.includes('--package')) assemble()
}

/** out/cli-package: exactly what `npm publish` sends. */
function assemble() {
  const dir = join(root, 'out', 'cli-package')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  // The map is 7 MB and only useful here; leave it and its comment out.
  const bundle = readFileSync(outfile, 'utf8').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n')
  // esbuild names each module by its path. Through a symlinked node_modules those paths climb out of the
  // checkout into the builder's home folder, which mustn't be published.
  if (bundle.includes(homedir())) throw new Error(`The bundle contains paths under ${homedir()}. Build from a checkout with its own node_modules (not a symlink).`)
  writeFileSync(join(dir, 'eaon.mjs'), bundle)
  chmodSync(join(dir, 'eaon.mjs'), 0o755)
  for (const [from, to] of [
    ['cli/README.md', 'README.md'],
    ['LICENSE.md', 'LICENSE.md'],
    ['NOTICE', 'NOTICE']
  ]) {
    if (!existsSync(join(root, from))) throw new Error(`${from} is missing, and the package ships it.`)
    copyFileSync(join(root, from), join(dir, to))
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`Packaged ${pkg.name}@${pkg.version} in out/cli-package — publish it with: npm publish out/cli-package --tag latest`)
}
