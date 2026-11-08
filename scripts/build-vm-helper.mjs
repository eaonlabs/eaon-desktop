#!/usr/bin/env node
/**
 * Builds eaon-vm (native/vm-mac/main.swift), the helper that runs virtual
 * machines on a Mac with Apple's Virtualization framework, into
 * resources/vm/darwin/eaon-vm: one universal binary, signed with the
 * virtualization entitlement the framework insists on. The app ships it, and
 * so does the worker-host package (for a spare Mac linked as a worker
 * computer).
 *
 * Signed with a Developer ID when this Mac has one (EAON_VM_SIGN_IDENTITY
 * picks which), else ad-hoc. It matters beyond Gatekeeper: the helper serves
 * the VM's screen over VNC, and macOS's firewall lets Developer ID software
 * listen without asking, where an ad-hoc build gets a dialog on every
 * rebuild. The release build signs the app's copy again (entitlementsInherit
 * carries the same entitlement). Off macOS there is nothing to build: Linux
 * computers run VMs with QEMU instead.
 *
 *   node scripts/build-vm-helper.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
if (process.platform !== 'darwin') {
  console.log('eaon-vm: not on macOS, skipped.')
  process.exit(0)
}

const source = join(root, 'native/vm-mac/main.swift')
const entitlements = join(root, 'native/vm-mac/eaon-vm.entitlements')
const outDir = join(root, 'resources/vm/darwin')
const out = join(outDir, 'eaon-vm')
mkdirSync(outDir, { recursive: true })

// Up to date: nothing to do (the release script runs the full build more than once).
if (existsSync(out) && statSync(out).mtimeMs > Math.max(statSync(source).mtimeMs, statSync(entitlements).mtimeMs)) {
  console.log('eaon-vm: up to date.')
  process.exit(0)
}

const slices = []
for (const arch of ['arm64', 'x86_64']) {
  const slice = join(outDir, `eaon-vm-${arch}`)
  // macOS 13 is where Linux guests get an EFI boot loader.
  execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos13`, '-framework', 'Virtualization', source, '-o', slice], { stdio: 'inherit' })
  slices.push(slice)
}
execFileSync('lipo', ['-create', ...slices, '-output', out])
for (const slice of slices) rmSync(slice, { force: true })

/** The Developer ID to sign with: the one asked for, else the first this Mac has, else none (ad-hoc). */
function identity() {
  if (process.env.EAON_VM_SIGN_IDENTITY) return process.env.EAON_VM_SIGN_IDENTITY
  try {
    const found = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
    return /^\s*\d+\)\s+([0-9A-F]{40})\s+"Developer ID Application:/m.exec(found)?.[1] ?? null
  } catch {
    return null
  }
}
const signer = identity()
execFileSync('codesign', ['--force', '--sign', signer ?? '-', '--timestamp=none', '--entitlements', entitlements, '--options', 'runtime', out], { stdio: 'inherit' })
console.log(`Built ${out.slice(root.length + 1)} (${(statSync(out).size / 1024).toFixed(0)} KB, ${signer ? 'Developer ID' : 'ad-hoc'})`)
