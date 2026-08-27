import type { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Development helper: drives the UI and writes a PNG per state so the rendered
 * result can be compared against the design frames. Only runs when EAON_CAPTURE
 * points at an output directory.
 */

const helpers = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const all = (sel) => [...document.querySelectorAll(sel)];
  const byText = (text, sel = 'button,a,[role=button]') =>
    all(sel).find((el) => el.textContent.trim() === text) ||
    all(sel).find((el) => el.textContent.trim().startsWith(text));
  const byLabel = (label) => document.querySelector('[aria-label="' + label + '"]');
  const click = async (el, wait = 260) => {
    if (!el) throw new Error('missing element');
    window.__log = (window.__log || []).concat('click:' + el.textContent.trim().slice(0, 30));
    el.click();
    await sleep(wait);
  };
  const reset = async () => {
    document.querySelectorAll('.layer').forEach((l) => l.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await sleep(160);
  };
`

interface Step {
  name: string
  script: string
}

const STEPS: Step[] = [
  { name: '01-home', script: `await reset();` },
  { name: '03-approval-menu', script: `await reset(); await click(byText('Ask for approval'));` },
  {
    name: '04-plugins-menu',
    script: `await reset(); await click(all('.tray__btn')[1]);
             const connect = byText('Connect plugins', '.menu__item'); connect.dispatchEvent(new MouseEvent('mouseenter', {bubbles:true})); await sleep(300);`
  },
  { name: '05-add-menu', script: `await reset(); await click(byLabel('Add context'));` },
  {
    name: '06-model-menu',
    script: `await reset(); await click(all('.chip--model')[0]);
             const row = byText('Model', '.menu__item'); row.parentElement.dispatchEvent(new MouseEvent('mouseenter', {bubbles:true})); await sleep(320);`
  },
  {
    name: '07-effort-menu',
    script: `await reset(); await click(all('.chip--model')[0]);
             const row = byText('Effort', '.menu__item'); row.parentElement.dispatchEvent(new MouseEvent('mouseenter', {bubbles:true})); await sleep(320);`
  },
  { name: '08-browser', script: `await reset(); await click(byLabel('Toggle side panel'), 500);` },
  { name: '09-sidebar-collapsed', script: `await reset(); await click(byLabel('Close panel')); await click(byLabel('Hide sidebar'), 400);` },
  { name: '10-plugins-page', script: `await reset(); await click(byLabel('Show sidebar')); await click(byText('Plugins', '.nav-item'), 420);` },
  { name: '11-skills-page', script: `await click(byText('Skills', '.segment__item'), 420);` },
  { name: '12-skills-add-menu', script: `await click(byText('Add', '.btn'), 300);` },
  { name: '13-integrations-plugins', script: `await reset(); await click(byLabel('Manage'), 420);` },
  { name: '14-integrations-mcps', script: `await click(byText('MCPs2', '.manager__tab') || all('.manager__tab')[1], 320);` },
  { name: '15-integrations-skills', script: `await click(all('.manager__tab')[2], 320);` },
  { name: '16-settings-general', script: `await reset(); await click(byText('Settings', '.nav-item'), 460);` },
  { name: '17-settings-appearance', script: `await click(byText('Appearance', '.nav-item'), 420);` },
  { name: '18-settings-appearance-2', script: `document.querySelector('.settings__scroll').scrollTop = 1080; await sleep(300);` },
  { name: '20-settings-configuration', script: `await click(byText('Configuration', '.nav-item'), 380);` },
  { name: '22-settings-shortcuts', script: `await click(byText('Keyboard shortcuts', '.nav-item'), 380);` },
  { name: '23-settings-providers', script: `await click(byText('Model providers', '.nav-item'), 600);` },
  {
    name: '24-chat',
    script: `await click(byText('Back to app', '.settings__back'), 320);
             const ta = document.querySelector('.composer__input');
             const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
             setter.call(ta, 'hey how are you doing');
             ta.dispatchEvent(new Event('input', { bubbles: true }));
             await sleep(120);
             await click(byLabel('Send'), 900);`
  },
  {
    name: '25-mcp-servers',
    script: `await reset(); await click(byText('Settings', '.nav-item'), 380);
             await click(byText('MCP Servers', '.nav-item'), 420);`
  },
  {
    name: '25b-mcp-add-modal',
    script: `await click(byText('Add MCP Server', '.pill-btn'), 380);`
  },
  {
    name: '25c-local-server',
    script: `await reset(); await click(byText('Local API Server', '.nav-item'), 420);`
  },
  {
    name: '25d-system-monitor',
    script: `await click(byText('System Monitor', '.nav-item'), 500);`
  },
  {
    name: '25e-claude-code',
    script: `await click(byText('Claude Code', '.nav-item'), 420);`
  },
  { name: '26-light-theme', script: `await reset(); await click(byText('Appearance', '.nav-item'), 320); await click(byText('Light', '.theme-card'), 420);` },
  {
    name: '27-workspace-menu',
    script: `await reset(); await click(byText('Back to app', '.settings__back'));
             await click(document.querySelector('.workspace__button'));`
  },
  { name: '28-eaon-work', script: `await click(byText('Eaon Work', '.menu__item'));` },
  { name: '28b-eaon-work-home', script: `await click(byText('New chat', '.nav-item'), 420);` },
  {
    name: '29-pull-requests',
    script: `await reset(); await click(byText('Pull requests', '.nav-item')); await sleep(2500);`
  },
  { name: '30-pr-selected', script: `await click(document.querySelector('.pr-row'), 300);` },
  {
    name: '33-code-index',
    script: `await reset(); await click(byText('Settings', '.footer-item') || byText('Settings', '.nav-item'), 400);
             await click(byText('Code index', '.nav-item'), 500);`
  },
  { name: '31-models', script: `await reset(); await click(byText('Models', '.nav-item')); await sleep(3500);` },
  { name: '32-models-detail', script: `await click(all('.model-variants-btn')[0]); await sleep(3000);` },
  {
    name: '34-model-menu-long',
    script: `await reset();
      const back = byText('Back to app', '.settings__back'); if (back) await click(back, 400);
      // Seed a provider with a long model list + a very long model id, which is
      // the shape that broke the menu height and the composer chip.
      const names = ['auto','kimi k3','kimi k2.7 code','kimi k2.6','kimi k2.5','glm 5.1','glm 5','qwen3.8 max','qwen3.7 max','qwen3.7 plus','qwen3.6 plus','qwen3.5 plus','minimax m3','minimax m2.7','minimax m2.5','mimo v2.5 pro','mimo v2.5','deepseek v4 pro','hy3','GPT 5.6 luna','grok 4.5','deepseek v4 flash','nemotron 3 super 120b extended'];
      for (let i=0;i<90;i++) names.push('filler model ' + i);
      const models = names.map((n,i) => ({ id: 'm'+i, label: n, providerId: 'openrouter' }));
      const st = window.__perfStore ? window.__perfStore.getState() : null;
      if (st) {
        const providers = st.providers.map(p => p.id === 'openrouter' ? { ...p, hasKey: true, enabled: true, models } : p);
        window.__perfStore.setState({ providers, settings: { ...st.settings, selectedModelId: 'm22' } });
      }
      await sleep(400);
      await click(all('.chip--model')[0]);
      const row = all('.menu__item').find(el => el.textContent.trim().startsWith('Model'));
      await click(row, 500);
      // Scroll the list so items pass *under* the sticky search header — the
      // only state in which bleed-through is visible.
      const list = all('.menu').find(m => m.scrollHeight > m.clientHeight);
      if (list) { list.scrollTop = 220; await sleep(350); }
      const menus = all('.menu').map(m => { const r = m.getBoundingClientRect(); return {h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), scrollable: m.scrollHeight > m.clientHeight}; });
      const chip = document.querySelector('.chip--model');
      const cr = chip.getBoundingClientRect();
      const hint = document.querySelector('.menu__item-hint');
      window.__log = (window.__log||[]).concat('MEASURE ' + JSON.stringify({viewport: window.innerHeight, menus, chipW: Math.round(cr.width), chipOverflows: chip.scrollWidth > chip.clientWidth + 1, modelRowText: row.textContent.trim(), hintW: hint ? Math.round(hint.getBoundingClientRect().width) : null}));`
  },
  {
    name: '35-light-provider-accent',
    script: `await reset();
      const back = byText('Back to app', '.settings__back'); if (back) await click(back, 300);
      await click(byText('Settings', '.footer-item') || byText('Settings', '.nav-item'), 350);
      await click(byText('Appearance', '.nav-item'), 320);
      await click(byText('Light', '.theme-card'), 450);
      await click(byText('Local API Server', '.nav-item'), 450);
      const cs = getComputedStyle(document.documentElement);
      const btn = document.querySelector('.btn--provider');
      window.__log = (window.__log||[]).concat('THEME ' + JSON.stringify({
        theme: document.documentElement.dataset.theme,
        accent: cs.getPropertyValue('--accent').trim(),
        providerAccent: cs.getPropertyValue('--provider-accent').trim(),
        providerStrong: cs.getPropertyValue('--provider-accent-strong').trim(),
        btnBg: btn ? getComputedStyle(btn).backgroundColor : null
      }));`
  },
  {
    name: '36-model-menu-dark',
    script: `await reset();
      await click(byText('Settings', '.footer-item') || byText('Settings', '.nav-item'), 350);
      await click(byText('Appearance', '.nav-item'), 320);
      await click(byText('Dark', '.theme-card'), 450);
      await click(byText('Back to app', '.settings__back'), 350);
      await click(all('.chip--model')[0]);
      const row = all('.menu__item').find(el => el.textContent.trim().startsWith('Model'));
      await click(row, 450);
      const list = all('.menu').find(m => m.scrollHeight > m.clientHeight);
      if (list) { list.scrollTop = 220; await sleep(350); }
      const sb = document.querySelector('.menu__search');
      const r = sb.getBoundingClientRect();
      window.__log = (window.__log||[]).concat('DARKBAR ' + JSON.stringify({
        theme: document.documentElement.dataset.theme,
        bg: getComputedStyle(sb).backgroundColor,
        rect: {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)}
      }));`
  }
]

export async function runCapture(window: BrowserWindow, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true })

  await new Promise((resolve) => setTimeout(resolve, 1400))

  for (const step of STEPS) {
    try {
      await window.webContents.executeJavaScript(
        `(async () => { ${helpers} ${step.script} })()`,
        true
      )
    } catch (error) {
      console.error(`[capture] ${step.name}: ${(error as Error).message}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 700))
    const state = await window.webContents.executeJavaScript(
      `JSON.stringify({ log: (window.__log || []).splice(0), settings: !!document.querySelector('.settings'), page: !!document.querySelector('.page'), menus: document.querySelectorAll('.menu').length })`
    )
    console.log(`[capture] ${step.name} state ${state}`)
    const image = await window.webContents.capturePage()
    writeFileSync(join(outDir, `${step.name}.png`), image.toPNG())
    console.log(`[capture] wrote ${step.name}.png`)
  }
  console.log('[capture] done')
}
