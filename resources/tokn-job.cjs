'use strict'
/**
 * Eaon's background tokn sync (main/features/toknJob.ts). The operating
 * system starts this with Eaon's own Node (ELECTRON_RUN_AS_NODE=1), also
 * while Eaon is closed: a LaunchAgent on macOS, a systemd user timer on
 * Linux, a scheduled task on Windows (through `Eaon --tokn-sync`).
 *
 * It runs the tokn command that ships next to it as `tokn autosync`, which
 * publishes at most every 90 minutes (tokn's own throttle), skips the scan
 * when no CLI wrote anything since the last sync, never prints and always
 * exits 0; it notes what it did in ~/.tokn/autosync.log. The run that starts
 * at 23:59 is `tokn autosync --daily`, which closes the day whatever the
 * throttle says, as tokn's own scheduler does.
 *
 * Plain CommonJS with no dependencies: it is not bundled, it ships as is
 * (electron-builder.yml).
 */
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

/** The bundled tokn, next to this file (EAON_TOKN_CLI_DIR while developing and testing). */
function toknScript() {
  return join(process.env.EAON_TOKN_CLI_DIR || join(__dirname, 'tokn-cli'), 'dist', 'index.js')
}

/** tokn's arguments for a run that starts at `now`. */
function toknArgs(now = new Date()) {
  return now.getHours() === 23 && now.getMinutes() === 59 ? ['autosync', '--daily'] : ['autosync']
}

function run(now = new Date()) {
  const script = toknScript()
  process.env.TOKN_NO_UPDATE_CHECK = '1'
  process.env.NO_COLOR = '1'
  // tokn reads its arguments from process.argv, as if it were started as `tokn autosync`.
  process.argv = [process.execPath, script, ...toknArgs(now)]
  return import(pathToFileURL(script).href)
}

module.exports = { toknScript, toknArgs, run }

// Started as a script (Linux, Windows, a development build). The macOS agent
// can't name this file by its full path, so it requires it and calls run().
if (require.main === module) run()
