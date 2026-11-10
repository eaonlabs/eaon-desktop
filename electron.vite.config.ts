import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { gatewayApp } from './scripts/gateway-app.mjs'

/**
 * Labs features (Workers' linked apps) are in dev builds and in builds made
 * with EAON_LABS=1, never in an ordinary release build. EAON_LABS=0 turns
 * them off in dev too.
 */
const labs = (command: string): string => JSON.stringify(process.env.EAON_LABS === '1' || (process.env.EAON_LABS !== '0' && command === 'serve'))

/**
 * KaTeX's stylesheet lists each font as woff2, woff and ttf, and a build
 * ships all three. Electron reads woff2, so the other two copies (most of a
 * megabyte) are dropped from the sheet and never copied into the app.
 */
const katexWoff2Only = (): Plugin => ({
  name: 'katex-woff2-only',
  enforce: 'pre',
  transform(code, id) {
    if (!id.split('?')[0].endsWith('katex/dist/katex.min.css')) return null
    return code.replace(/,url\([^)]*\.woff\) format\("woff"\),url\([^)]*\.ttf\) format\("truetype"\)/g, '')
  }
})

export default defineConfig(({ command }) => ({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // Signing requests to Eaon's gateway: main only (scripts/gateway-app.mjs).
    define: { __EAON_LABS__: labs(command), ...gatewayApp },
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // CommonJS: the window is sandboxed (main/index.ts), and a sandboxed
    // preload can't be an ES module. It needs nothing but `electron`.
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    define: { __EAON_LABS__: labs(command) },
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        // Mermaid's optional ELK layout, left out (see the file).
        'elkjs/lib/elk.bundled.js': resolve('src/renderer/src/lib/elkStub.ts')
      }
    },
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } },
    plugins: [react(), katexWoff2Only()]
  }
}))
