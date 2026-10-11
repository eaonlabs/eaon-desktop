// Screenshots of the Eaon Remote web app, for the rc end-to-end test:
//   electron captureWeb.cjs <base url> <cookie value or -> <out dir> <name|path|width|height>...
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const [base, cookie, out, ...shots] = process.argv.slice(2)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  if (cookie !== '-') await session.defaultSession.cookies.set({ url: base, name: 'rc_session', value: cookie })
  const win = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { offscreen: false } })
  fs.mkdirSync(out, { recursive: true })
  for (const shot of shots) {
    const [name, route, w, h] = shot.split('|')
    win.setContentSize(Number(w), Number(h))
    await win.loadURL(base + route)
    await wait(3500)
    fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  app.quit()
})
