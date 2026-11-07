import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../src/renderer/src/components/agent/Markdown'
import { diagramConfig, drawDiagram, forgetDiagrams, svgDataUri, svgSize, type DiagramEngine } from '../src/renderer/src/components/agent/mermaidRender'

/** What the chat draws for a reply, as HTML. */
const html = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }))

const SVG = '<svg id="eaon-diagram-1" width="100%" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 312.5 180" style="max-width: 312.5px;"><g><text>A</text></g></svg>'

/** A stand-in for Mermaid: what it was asked, in order, and what it answers. */
function fakeEngine(render: (id: string, text: string) => Promise<{ svg: string }>): { engine: DiagramEngine; configs: unknown[]; texts: string[] } {
  const configs: unknown[] = []
  const texts: string[] = []
  const engine = {
    initialize: (config: unknown) => void configs.push(config),
    render: (id: string, text: string) => {
      texts.push(text)
      return render(id, text)
    }
  } as unknown as DiagramEngine
  return { engine, configs, texts }
}

test('the drawing is shown at the size it was laid out in', () => {
  assert.deepEqual(svgSize(SVG), { width: 313, height: 180 })
  assert.deepEqual(svgSize('<svg viewBox="0,0,40,20"></svg>'), { width: 40, height: 20 })
  assert.equal(svgSize('<svg width="10" height="10"></svg>'), null)
  assert.equal(svgSize('<svg viewBox="0 0 0 0"></svg>'), null)
  // A viewBox further in the markup is not the picture's own.
  assert.equal(svgSize('<svg><g viewBox="0 0 5 5"></g></svg>'), null)
})

test('Mermaid runs strict, off the page, with no error graphic and plain SVG text', () => {
  for (const dark of [true, false]) {
    const config = diagramConfig(dark)
    assert.equal(config.securityLevel, 'strict')
    assert.equal(config.startOnLoad, false)
    assert.equal(config.htmlLabels, false)
    assert.equal(config.suppressErrorRendering, true)
    assert.equal(config.theme, dark ? 'dark' : 'neutral')
  }
})

test('a diagram comes back as an image, drawn once per theme', async () => {
  forgetDiagrams()
  const { engine, configs, texts } = fakeEngine(async () => ({ svg: SVG }))
  const load = async (): Promise<DiagramEngine> => engine
  const first = await drawDiagram('  flowchart TD\n  A --> B\n', true, load)
  assert.ok(first.ok)
  if (first.ok) {
    assert.equal(first.src, svgDataUri(SVG))
    assert.match(first.src, /^data:image\/svg\+xml;charset=utf-8,%3Csvg/)
    assert.equal(first.width, 313)
    assert.equal(first.height, 180)
  }
  assert.deepEqual(texts, ['flowchart TD\n  A --> B'])
  assert.equal((configs[0] as { securityLevel: string }).securityLevel, 'strict')
  // The same diagram again is not drawn again; the other theme is.
  assert.equal(await drawDiagram('flowchart TD\n  A --> B', true, load), first)
  assert.equal(texts.length, 1)
  await drawDiagram('flowchart TD\n  A --> B', false, load)
  assert.equal(texts.length, 2)
  assert.equal((configs[1] as { theme: string }).theme, 'neutral')
})

test('a diagram Mermaid cannot read, an empty one and an enormous one are not drawn', async () => {
  forgetDiagrams()
  const broken = fakeEngine(async () => {
    throw new Error('Parse error on line 2')
  })
  assert.deepEqual(await drawDiagram('flowchart TD\n A --> ', true, async () => broken.engine), { ok: false })
  // Mermaid answering with something that is not a picture is a failure too.
  const odd = fakeEngine(async () => ({ svg: '<div>nope</div>' }))
  assert.deepEqual(await drawDiagram('graph TD\n A-->B', true, async () => odd.engine), { ok: false })
  // Not asked at all.
  const never = fakeEngine(async () => ({ svg: SVG }))
  assert.deepEqual(await drawDiagram('   \n ', true, async () => never.engine), { ok: false })
  assert.deepEqual(await drawDiagram(`graph TD\n${'A-->B\n'.repeat(5000)}`, true, async () => never.engine), { ok: false })
  assert.equal(never.texts.length, 0)
  // Mermaid failing to load (a missing file) is a failure, not an exception.
  assert.deepEqual(await drawDiagram('graph TD\n C-->D', true, async () => null), { ok: false })
})

test('diagrams are drawn one at a time', async () => {
  forgetDiagrams()
  let running = 0
  let most = 0
  const slow = fakeEngine(async () => {
    running++
    most = Math.max(most, running)
    await new Promise((resolve) => setTimeout(resolve, 5))
    running--
    return { svg: SVG }
  })
  await Promise.all(['graph TD\n A-->B', 'graph TD\n B-->C', 'graph TD\n C-->D'].map((text) => drawDiagram(text, true, async () => slow.engine)))
  assert.equal(slow.texts.length, 3)
  assert.equal(most, 1)
})

test('a finished mermaid block is drawn as a diagram; one still streaming, and one that failed, are code', async () => {
  forgetDiagrams()
  const source = 'flowchart TD\n  A[Start] --> B[Done]'
  const reply = (fence: string): string => `Here it is:\n\n\`\`\`mermaid\n${source}${fence}`
  // Not drawn yet: the block is there with its toggle and a placeholder.
  const pending = html(reply('\n```'))
  assert.match(pending, /class="code-block mermaid-block"/)
  assert.match(pending, /Show source/)
  assert.match(pending, /Drawing diagram/)
  // Streaming: ordinary code, whatever the language.
  const streaming = html(reply(''))
  assert.doesNotMatch(streaming, /mermaid-block/)
  assert.match(streaming, /data-streaming="true"/)

  // Drawn: the image, with the default view the diagram.
  const ok = fakeEngine(async () => ({ svg: SVG }))
  await drawDiagram(source, true, async () => ok.engine)
  const drawn = html(reply('\n```'))
  assert.match(drawn, /<img class="mermaid-block__img" src="data:image\/svg\+xml;charset=utf-8,%3Csvg/)
  assert.match(drawn, /width="313" height="180"/)
  assert.doesNotMatch(drawn, /Drawing diagram/)

  // Unreadable: the code block, with the reason in its header.
  forgetDiagrams()
  const bad = fakeEngine(async () => {
    throw new Error('Parse error')
  })
  await drawDiagram(source, true, async () => bad.engine)
  const failed = html(reply('\n```'))
  assert.doesNotMatch(failed, /mermaid-block/)
  assert.match(failed, /Couldn’t draw this diagram/)
  assert.match(failed, /Start/)
  forgetDiagrams()
})

test('other languages are untouched', () => {
  const out = html('```ts\nconst a = 1\n```')
  assert.doesNotMatch(out, /mermaid/)
  assert.match(out, /code-block__lang">ts</)
})
