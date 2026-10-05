// A local site of difficult pages for the agent browser (agentBrowser-live.test.ts). No external hosts.
import { createServer } from 'node:http'

const page = (title, body, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`

export function startFixtures() {
  const hits = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    hits.push(url.pathname)
    const html = (status, title, body, head, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers })
      res.end(page(title, body, head))
    }
    const cookies = Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => c.split('=')))
    switch (url.pathname) {
      case '/':
        return html(200, 'Home', '<h1>Fixture home</h1><a href="/landing">Landing</a> <a href="/about">About</a>')
      case '/landing':
        return html(200, 'Landing', '<h1>Landed</h1><p>You are on the landing page.</p><a href="/">Home</a>')
      case '/about':
        return html(200, 'About', '<h1>About us</h1><a href="/">Home</a>')
      case '/redirect':
        res.writeHead(302, { location: '/redirect2' })
        return res.end()
      case '/redirect2':
        res.writeHead(301, { location: '/landing?via=redirect' })
        return res.end()
      case '/newtab':
        return html(
          200,
          'New tab links',
          '<h1>Links</h1><a href="/landing" target="_blank">Open landing in a new tab</a> <button onclick="window.open(\'/about\', \'pop\', \'width=400,height=300\')">Open popup</button>'
        )
      case '/login':
        if (req.method === 'POST') {
          let body = ''
          req.on('data', (c) => (body += c))
          req.on('end', () => {
            const user = new URLSearchParams(body).get('user') || 'anon'
            res.writeHead(303, { location: '/account', 'set-cookie': `sid=${encodeURIComponent(user)}; Path=/; Max-Age=86400; HttpOnly` })
            res.end()
          })
          return
        }
        return html(200, 'Sign in', '<h1>Sign in</h1><form method="post" action="/login"><label>Username <input name="user"></label> <button type="submit">Sign in</button></form>')
      case '/account':
        if (!cookies.sid) {
          res.writeHead(302, { location: '/login' })
          return res.end()
        }
        return html(200, 'Account', `<h1>Signed in as ${decodeURIComponent(cookies.sid)}</h1><a href="/logout">Sign out</a>`)
      case '/spa':
        return html(
          200,
          'SPA',
          `<nav><a href="/spa/one" data-spa>Section one</a> <a href="/spa/two" data-spa>Section two</a></nav><main id="m"><h1>SPA home</h1></main>
<script>
document.addEventListener('click', (e) => { const a = e.target.closest('a[data-spa]'); if (!a) return; e.preventDefault();
  setTimeout(() => { history.pushState({}, '', a.getAttribute('href')); document.getElementById('m').innerHTML = '<h1>' + a.textContent + ' content</h1><button>Action in ' + a.textContent + '</button>' }, 300) })
</script>`
        )
      case '/infinite':
        return html(
          200,
          'Infinite',
          `<div id="list"></div><script>
let n = 0; const list = document.getElementById('list');
function more() { for (let i = 0; i < 30; i++) { const p = document.createElement('p'); p.textContent = 'Item ' + (++n); p.style.height = '40px'; list.appendChild(p) } }
more(); addEventListener('scroll', () => { if (innerHeight + scrollY > document.body.scrollHeight - 200 && n < 300) setTimeout(more, 200) })
</script>`
        )
      case '/download':
        return html(200, 'Download', '<a href="/file.pdf">Get the report</a>')
      case '/file.pdf':
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="report.pdf"' })
        return res.end('%PDF-1.4 fake')
      case '/private.pdf':
        if (!cookies.sid) {
          res.writeHead(403, { 'content-type': 'text/plain' })
          return res.end('sign in first')
        }
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="statement.pdf"' })
        return res.end('%PDF-1.4 private for ' + cookies.sid)
      case '/upload':
        return html(
          200,
          'Upload',
          '<label>Attachment <input type="file" id="f" onchange="document.getElementById(\'out\').textContent = \'Chosen: \' + [...this.files].map(f => f.name + \' \' + f.size).join(\', \')"></label><p id="out">Nothing chosen</p>'
        )
      case '/iframe':
        return html(200, 'Iframe', '<h1>Outer</h1><iframe src="/frame-inner" width="400" height="200" title="Inner frame"></iframe><p id="o">outer</p>')
      case '/frame-inner':
        return html(200, 'Inner', '<button onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<p>Inner clicked</p>\')">Inner button</button>')
      case '/shadow':
        return html(
          200,
          'Shadow',
          `<h1>Shadow DOM</h1><x-widget></x-widget><p id="r">not clicked</p><script>
customElements.define('x-widget', class extends HTMLElement { connectedCallback() { const root = this.attachShadow({ mode: 'open' });
  root.innerHTML = '<button id="b">Shadow button</button><input placeholder="Shadow field">';
  root.getElementById('b').onclick = () => { document.getElementById('r').textContent = 'shadow clicked' } } })
</script>`
        )
      case '/hydrate':
        return html(
          200,
          'Hydrate',
          `<button id="b">Load more</button><p id="r">idle</p><script>
setTimeout(() => { document.getElementById('b').onclick = () => { document.getElementById('r').textContent = 'loaded' } }, 2500)
</script>`
        )
      case '/stale':
        return html(
          200,
          'Stale',
          `<div id="list"><button class="it">Alpha</button><button class="it">Beta</button></div><button id="re" onclick="document.getElementById('list').innerHTML = '<button class=it>Gamma</button>'">Refresh list</button>`
        )
      case '/navigate-during':
        return html(200, 'Nav during', `<button onclick="location.href='/landing'">Go now</button><button onclick="setTimeout(() => location.href='/about', 50)">Go soon</button>`)
      case '/overlay':
        return html(
          200,
          'Overlay',
          `<button id="b" onclick="document.getElementById('r').textContent='clicked'">Covered button</button><p id="r">no</p>
<div style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center"><div style="background:#fff;padding:20px">Cookie consent <button onclick="this.closest('div').parentElement.remove()">Accept cookies</button></div></div>`
        )
      case '/blocked':
        return html(
          403,
          'Just a moment...',
          '<h1>Checking if the site connection is secure</h1><p>Enable JavaScript and cookies to continue</p><div id="challenge-form">cf-chl</div>',
          '',
          { server: 'cloudflare', 'cf-mitigated': 'challenge' }
        )
      case '/slow':
        // Never answers.
        return
      case '/reset':
        req.socket.destroy()
        return
      case '/basic':
        if (req.headers.authorization) return html(200, 'Basic ok', '<h1>Basic auth ok</h1>')
        res.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"', 'content-type': 'text/html' })
        return res.end('<h1>401</h1>')
      case '/cookie':
        return html(200, 'Cookie', `<p id="c">sid=${cookies.sid ?? '(none)'}</p>`)
      case '/select':
        return html(200, 'Select', '<label>Size <select><option>Small</option><option>Large</option></select></label>')
      case '/broken-js':
        return html(200, 'Broken', '<h1>Broken</h1><script>throw new Error("boom")</script>')
      case '/disabled':
        return html(200, 'Disabled', '<button disabled>Submit order form</button>')
      case '/webagents.md':
      case '/.well-known/webagents.json':
        res.writeHead(404)
        return res.end()
      default:
        return html(404, 'Not found', `<h1>404 ${url.pathname}</h1>`)
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, port, base: `http://127.0.0.1:${port}`, hits })
    })
  })
}
