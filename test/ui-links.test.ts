import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DOCS_URL, ISSUES_URL, RELEASES_URL, REPO_URL, releaseNotesUrl, releaseTagUrl } from '../src/shared/links'

const root = process.cwd()

test('the repository links point at the eaonlabs organisation', () => {
  assert.equal(REPO_URL, 'https://github.com/eaonlabs/eaon-desktop')
  assert.equal(RELEASES_URL, `${REPO_URL}/releases`)
  assert.equal(ISSUES_URL, `${REPO_URL}/issues`)
  assert.match(DOCS_URL, /^https:\/\/eaon\.dev\/docs$/)
})

test('a version names its release tag; anything else has none', () => {
  assert.equal(releaseTagUrl('2026.6.1'), `${RELEASES_URL}/tag/v2026.6.1`)
  assert.equal(releaseTagUrl('v2026.6.1'), `${RELEASES_URL}/tag/v2026.6.1`)
  assert.equal(releaseTagUrl('2026.6.0-rc.1'), `${RELEASES_URL}/tag/v2026.6.0-rc.1`)
  assert.equal(releaseTagUrl(' 2026.6.2 '), `${RELEASES_URL}/tag/v2026.6.2`)
  assert.equal(releaseTagUrl(''), null)
  assert.equal(releaseTagUrl('dev'), null)
  assert.equal(releaseTagUrl('2026.6'), null)
  assert.equal(releaseTagUrl('1.0.0/../../evil'), null)
})

test('release notes open the running version when GitHub has it, else the list', async () => {
  const asked: string[] = []
  const has = (urls: string[]) => async (url: string): Promise<boolean> => {
    asked.push(url)
    return urls.includes(url)
  }
  assert.equal(await releaseNotesUrl('2026.6.1', has([`${RELEASES_URL}/tag/v2026.6.1`])), `${RELEASES_URL}/tag/v2026.6.1`)
  // A local build of an unreleased version: no tag yet.
  assert.equal(await releaseNotesUrl('2026.6.2', has([])), RELEASES_URL)
  // Offline, timed out or rate limited: the list still opens.
  assert.equal(
    await releaseNotesUrl('2026.6.1', async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED')
    }),
    RELEASES_URL
  )
  // Nothing to look up for a version no tag could carry.
  asked.length = 0
  assert.equal(await releaseNotesUrl('dev', has([])), RELEASES_URL)
  assert.deepEqual(asked, [])
})

/** Every text file under `dir`, skipping build output and dependencies. */
function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'out' || name === 'dist' || name.startsWith('.')) continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...files(path))
    else if (/\.(ts|tsx|js|mjs|cjs|json|ya?ml|md|html|css|sh)$/.test(name)) out.push(path)
  }
  return out
}

test('nothing still points at the repository under its old owner', () => {
  // The repository moved from github.com/sanscreates to the eaonlabs
  // organisation; Settings → General kept linking the old one in 2026.6.1.
  // The Discord test uses "sanscreates" as a Discord username, which is fine.
  const scanned = ['src', 'cli', 'extension', 'scripts', 'docs', 'resources', '.github']
    .map((dir) => join(root, dir))
    .flatMap((dir) => {
      try {
        return files(dir)
      } catch {
        return []
      }
    })
    .concat(['package.json', 'electron-builder.yml', 'README.md', 'CHANGELOG.md', 'cli/package.json'].map((f) => join(root, f)))
  const stale = scanned.filter((path) => /github\.com\/sanscreates|@sanscreates|sanscreates\/eaon/i.test(readFileSync(path, 'utf8')))
  assert.deepEqual(stale.map((path) => relative(root, path)), [])
})

test('Settings → General takes its links from shared/links.ts', () => {
  const general = readFileSync(join(root, 'src/renderer/src/components/settings/pages/General.tsx'), 'utf8')
  assert.doesNotMatch(general, /https:\/\/github\.com/, 'a hard-coded GitHub URL drifts when the repository moves')
  for (const name of ['DOCS_URL', 'ISSUES_URL', 'REPO_URL']) assert.match(general, new RegExp(name))
  assert.match(general, /openReleaseNotes\(\)/)
})
