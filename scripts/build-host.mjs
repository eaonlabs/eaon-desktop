#!/usr/bin/env node
/**
 * Builds the Eaon worker host (src/host/): the app Eaon Desktop installs on a
 * worker computer, as one package the desktop carries and sends over.
 *
 *   out/host/eaon-host.tgz    eaon-host/ — what the desktop uploads
 *     eaon-host.mjs           the host under Electron (workers with browsers)
 *     eaon-host-node.mjs      the same under plain Node, `electron` stood in by
 *                             the CLI's (cli/src/runtime/electron.ts), for a
 *                             computer that can't run Electron's windows
 *     node_modules/           BetterWright and what it needs: it runs part of
 *                             itself in a worker process, so it can't be bundled
 *     install.sh              installs, updates and removes it there
 *     host-build.json         this build's id and the Electron it runs on
 *   out/host/eaon-host.json   the same id, plus the package's hash and size, for the desktop
 *
 * The package is the same for every platform: install.sh downloads the
 * Electron that fits the computer it lands on.
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const out = join(root, 'out', 'host')
const pkgDir = join(out, 'pkg', 'eaon-host')
const appPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const electronVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version
const PLACEHOLDER = 'EAON_HOST_BUILD_0000000000'

rmSync(out, { recursive: true, force: true })
mkdirSync(pkgDir, { recursive: true })

/** Native, Electron-only, or run as separate processes: loaded from node_modules, or never reached by the host. */
const external = ['node-pty', 'betterwright', 'betterwright/*', 'baileys', 'electron-updater', '@xterm/*', 'bufferutil', 'utf-8-validate']

const common = {
  entryPoints: [join(root, 'src/host/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external,
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  loader: { '.md': 'text' },
  logLevel: 'warning'
}

await build({
  ...common,
  outfile: join(pkgDir, 'eaon-host.mjs'),
  external: [...external, 'electron'],
  alias: { '@shared': join(root, 'src/shared'), '@main': join(root, 'src/main') },
  define: { __EAON_HOST_RUNTIME__: '"electron"', __EAON_HOST_BUILD__: JSON.stringify(PLACEHOLDER), __EAON_APP_VERSION__: JSON.stringify(appPkg.version) }
})
await build({
  ...common,
  outfile: join(pkgDir, 'eaon-host-node.mjs'),
  alias: { electron: join(root, 'cli/src/runtime/electron.ts'), '@shared': join(root, 'src/shared'), '@main': join(root, 'src/main') },
  define: {
    __EAON_HOST_RUNTIME__: '"node"',
    __EAON_HOST_BUILD__: JSON.stringify(PLACEHOLDER),
    __EAON_APP_VERSION__: JSON.stringify(appPkg.version),
    __EAON_CLI_VERSION__: JSON.stringify(appPkg.version),
    __EAON_CLI_PACKAGE__: '"eaon-host"'
  }
})

/* BetterWright and everything it depends on, as installed here. */
const copied = new Set()
function copyModule(name, from) {
  let dir = null
  for (let base = from; ; base = dirname(base)) {
    const candidate = join(base, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) {
      dir = candidate
      break
    }
    if (base === root || base === dirname(base)) break
  }
  if (!dir) throw new Error(`${name} isn't installed (needed by the worker host).`)
  if (copied.has(dir)) return
  copied.add(dir)
  const target = join(pkgDir, 'node_modules', dir.slice(join(root, 'node_modules').length + 1))
  // BetterWright's optional extras Eaon leaves out of the app too (electron-builder.yml).
  cpSync(dir, target, { recursive: true, dereference: true, filter: (src) => !/[\\/]node_modules[\\/](rookie-cookies|patchright-core)/.test(src.slice(dir.length)) })
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  for (const dep of Object.keys(manifest.dependencies ?? {})) copyModule(dep, dir)
}
copyModule('betterwright', root)

copyFileSync(join(root, 'src/host/install.sh'), join(pkgDir, 'install.sh'))
chmodSync(join(pkgDir, 'install.sh'), 0o755)
writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify({ name: 'eaon-host', private: true, type: 'module', main: 'eaon-host.mjs', version: appPkg.version }, null, 2)}\n`)

// The build id: what the bundles and the installer say, so the desktop knows when the host is behind.
const hash = createHash('sha256')
for (const file of ['eaon-host.mjs', 'eaon-host-node.mjs', 'install.sh']) hash.update(readFileSync(join(pkgDir, file)))
for (const dir of [...copied].sort()) hash.update(dir.slice(root.length))
const buildId = `${appPkg.version}-${hash.digest('hex').slice(0, 12)}`
for (const file of ['eaon-host.mjs', 'eaon-host-node.mjs']) {
  const path = join(pkgDir, file)
  writeFileSync(path, readFileSync(path, 'utf8').split(PLACEHOLDER).join(buildId))
}
writeFileSync(join(pkgDir, 'host-build.json'), `${JSON.stringify({ build: buildId, electron: electronVersion, appVersion: appPkg.version }, null, 2)}\n`)

const tgz = join(out, 'eaon-host.tgz')
// No macOS extended attributes in the archive: GNU tar on the host warns about every one.
// Relative paths, run from out/host: GNU tar (Git Bash on Windows) reads "C:" in a path as a remote host.
execFileSync('tar', ['-czf', 'eaon-host.tgz', '-C', 'pkg', 'eaon-host'], { cwd: out, env: { ...process.env, COPYFILE_DISABLE: '1' } })
const sha256 = createHash('sha256').update(readFileSync(tgz)).digest('hex')
writeFileSync(join(out, 'eaon-host.json'), `${JSON.stringify({ build: buildId, electron: electronVersion, appVersion: appPkg.version, sha256, size: statSync(tgz).size }, null, 2)}\n`)
rmSync(join(out, 'pkg'), { recursive: true, force: true })
console.log(`Built out/host/eaon-host.tgz (${buildId}, ${(statSync(tgz).size / 1e6).toFixed(1)} MB, Electron ${electronVersion})`)
