// node-pty ships a small `spawn-helper` binary beside each prebuilt pty.node,
// and npm unpacks it without the execute bit. Every spawn then fails with
// "posix_spawnp failed". Runs as postinstall; harmless when already fixed or
// on platforms without the helper.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const roots = ['node_modules/node-pty/prebuilds', 'node_modules/node-pty/build/Release']
for (const root of roots) {
  if (!existsSync(root)) continue
  const dirs = root.endsWith('Release') ? [root] : readdirSync(root).map((d) => join(root, d))
  for (const dir of dirs) {
    const helper = join(dir, 'spawn-helper')
    if (!existsSync(helper)) continue
    const mode = statSync(helper).mode
    if ((mode & 0o111) !== 0o111) {
      chmodSync(helper, mode | 0o755)
      console.log(`[fix-node-pty] made ${helper} executable`)
    }
  }
}
