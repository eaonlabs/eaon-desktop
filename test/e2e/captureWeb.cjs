// Screenshots of the Eaon Remote web app, for the rc end-to-end test:
//   electron captureWeb.cjs <base url> <cookie value or -> <out dir> <name|path|width|height[|wait ms][|hold]>...
// hold: the computer's answers are held back (captureWebHold.cjs), so the page is caught loading.
// Each shot also saves the page's text as <name>.txt, for the test to read.
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const [base, cookie, out, ...shots] = process.argv.slice(2)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  if (cookie !== '-') await session.defaultSession.cookies.set({ url: base, name: 'rc_session', value: cookie })
  const plain = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { offscreen: false } })
  let held = null
  fs.mkdirSync(out, { recursive: true })
  for (const shot of shots) {
    const [name, route, w, h, ms, hold] = shot.split('|')
    if (hold && !held) {
      held = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        webPreferences: { preload: path.join(__dirname, 'captureWebHold.cjs'), contextIsolation: false, sandbox: false }
      })
    }
    const win = hold ? held : plain
    win.setContentSize(Number(w), Number(h))
    await win.loadURL(base + route)
    await wait(ms ? Number(ms) : 3500)
    fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG())
    fs.writeFileSync(path.join(out, `${name}.txt`), await win.webContents.executeJavaScript('document.body.innerText'))
  }
  app.quit()
})
