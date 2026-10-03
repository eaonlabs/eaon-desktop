/**
 * Runs Eaon Code's real installer (downloaded from GitHub) the way Settings →
 * Eaon Code does, into a temp folder, then starts the result over RPC through
 * the Code tab's bridge, and runs the installer again as "Check for updates"
 * does. Nothing touches ~/.local: the checkout and the wrapper go to temp
 * folders through EAON_CODE_PREFIX and EAON_CODE_BIN_DIR.
 *
 * Clones and builds the whole repo, so it takes a few minutes and needs the
 * network. Skips unless EAON_CODE_LIVE_INSTALL=1. EAON_CODE_LIVE_INSTALLER
 * names a local install.sh to run instead of GitHub's, to try a fix to the
 * installer before it is pushed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EaonCodeBridge } from '../src/main/features/eaonCode/bridge'
import { installEaonCode } from '../src/main/features/eaonCode/install'
import { detectEaonCode } from '../src/main/features/eaonCode/locate'

const live = process.env.EAON_CODE_LIVE_INSTALL === '1'
const localInstaller = process.env.EAON_CODE_LIVE_INSTALLER
const fetchScript = localInstaller ? async (): Promise<string> => readFileSync(localInstaller, 'utf8') : undefined

test('the real installer installs Eaon Code, the bridge starts it, and a second run updates it', { skip: !live, timeout: 30 * 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'eaon-code-live-install-'))
  const env = {
    ...process.env,
    EAON_CODE_PREFIX: join(root, 'eaon-code'),
    EAON_CODE_BIN_DIR: join(root, 'bin'),
    EAON_CODE_CODING_AGENT_DIR: join(root, 'agent')
  }
  const log: string[] = []
  const first = await installEaonCode((line) => log.push(line), { env, fetchScript })
  assert.ok(first.ok, `${first.message}\n${log.slice(-20).join('\n')}`)

  const status = await detectEaonCode(null, env)
  assert.equal(status.state, 'ready', status.error)
  assert.equal(status.source, 'installer')
  assert.equal(status.installDir, env.EAON_CODE_PREFIX)

  const bridge = new EaonCodeBridge({
    getSettings: () => ({ binaryPath: null, shareKeys: false }),
    getKey: () => undefined,
    onEvents: () => {},
    onProcess: () => {},
    env,
    detect: () => detectEaonCode(null, env)
  })
  try {
    const snapshot = await bridge.start(root)
    assert.equal(typeof snapshot.state.sessionId, 'string')
    assert.equal(bridge.processInfo().state, 'running')
  } finally {
    await bridge.stop()
  }

  const before = status.updatedAt ?? 0
  const second = await installEaonCode(() => {}, { env, fetchScript })
  assert.ok(second.ok, second.message)
  const after = await detectEaonCode(null, env)
  assert.equal(after.state, 'ready')
  assert.ok((after.updatedAt ?? 0) > before, 'the second run rewrote the marker')
})
