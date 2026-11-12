import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import katex from 'katex'
import { Markdown } from '../src/renderer/src/components/agent/Markdown'
import { parseMarkdown } from '../src/renderer/src/components/agent/markdownBlocks'
import { drawMath, katexReady, provideKatex, renderMath } from '../src/renderer/src/components/agent/mathRender'

/** What the chat draws for a reply, as HTML. */
const html = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }))
const blocks = (text: string) => parseMarkdown(text).blocks

test('a formula stays the LaTeX it was written in until KaTeX has loaded', () => {
  provideKatex(null)
  assert.equal(katexReady(), false)
  const out = html('Euler: $e^{i\\pi}+1=0$')
  assert.match(out, /<span class="md__math-src"><code>\$e\^\{i\\pi\}\+1=0\$<\/code><\/span>/)
  assert.doesNotMatch(out, /katex/)
  assert.equal(drawMath('x', false), null)
})

test('$...$ and \\(...\\) are drawn inline, $$...$$ and \\[...\\] on their own line', () => {
  provideKatex(katex)
  const inline = html('Euler: $e^{i\\pi}+1=0$, and \\(a^2\\) too.')
  assert.equal(inline.match(/<span class="md__math" data-find-skip="true">/g)?.length, 2)
  assert.match(inline, /<span class="katex">/)
  assert.doesNotMatch(inline, /data-display/)
  // The LaTeX is kept for screen readers and copying, beside the drawn formula.
  assert.match(inline, /<annotation encoding="application\/x-tex">e\^\{i\\pi\}\+1=0<\/annotation>/)

  const display = html('Before.\n\n$$\n\\int_0^1 x\\,dx = \\tfrac12\n$$\n\nAfter.')
  assert.match(display, /<span class="md__math" data-display="true" data-find-skip="true">/)
  assert.match(display, /katex-display/)
  assert.match(display, /<p class="md__p">Before\.<\/p>/)
  assert.match(display, /<p class="md__p">After\.<\/p>/)

  assert.match(html('\\[ a + b \\]'), /data-display="true"/)
  // A formula inside a sentence, written with $$.
  assert.match(html('so $$x^2$$ here'), /<p class="md__p">so <span class="md__math" data-display="true"/)
})

test('prices, shell variables and code are not formulas', () => {
  provideKatex(katex)
  for (const text of [
    'It costs $5 and $10 today.',
    'Between $5-$10 per month.',
    'I paid $5, he paid $6.',
    'Escaped \\$x\\$ stays text.',
    'A stray $ sign, and another $ one.',
    'echo $$ prints the shell pid'
  ]) {
    assert.doesNotMatch(html(text), /md__math/, text)
  }
  // Inside backticks a formula is code, with the dollars still in it.
  const code = html('Write `$x^2$` in the reply.')
  assert.match(code, /<code class="md__code">\$x\^2\$<\/code>/)
  assert.doesNotMatch(code, /md__math/)
  // Dollar signs in a paragraph keep their text.
  assert.equal(html('It costs $5 and $10 today.').replace(/<[^>]+>/g, ''), 'It costs $5 and $10 today.')
})

test('bad LaTeX shows its source and does not stop the rest of the reply', () => {
  provideKatex(katex)
  const out = html('Broken: $\\frac{1$ and fine: $x^2$.\n\n$$\n\\notacommand{\n$$\n\nStill here.')
  assert.match(out, /<span class="md__math-src"><code>\$\\frac\{1\$<\/code><\/span>/)
  assert.match(out, /<span class="md__math-src" data-display="true"><code>\$\$\n\\notacommand\{\n\$\$<\/code><\/span>/)
  assert.equal(out.match(/class="md__math"/g)?.length, 1)
  assert.match(out, /Still here\./)
})

test('a formula in a table cell, a list item and a heading is drawn', () => {
  provideKatex(katex)
  const out = html('## Result $x$\n\n- item with $y^2$\n\n| a | b |\n|---|---|\n| $z$ | 1 |')
  assert.equal(out.match(/class="md__math"/g)?.length, 3)
})

test('display formulas are found on their own lines only, and never run past a blank line', () => {
  assert.deepEqual(blocks('$$\nx^2\n$$'), [{ kind: 'math', src: 'x^2' }])
  assert.deepEqual(blocks('$$ E = mc^2 $$'), [{ kind: 'math', src: 'E = mc^2' }])
  assert.deepEqual(blocks('$$E = mc^2\n+ 1$$'), [{ kind: 'math', src: 'E = mc^2\n+ 1' }])
  assert.deepEqual(blocks('\\[\na + b\n\\]'), [{ kind: 'math', src: 'a + b' }])
  assert.deepEqual(blocks('Text first\n$$\nx\n$$\nand text after'), [
    { kind: 'para', text: 'Text first' },
    { kind: 'math', src: 'x' },
    { kind: 'para', text: 'and text after' }
  ])
  // Lines that look like Markdown inside the formula are the formula's.
  assert.deepEqual(blocks('$$\n- a\n# b\n1. c\n$$'), [{ kind: 'math', src: '- a\n# b\n1. c' }])
  // No closing line before a blank line: text, and what follows is parsed as usual.
  assert.deepEqual(blocks('$$ is the pid\nof the shell\n\n# Heading'), [
    { kind: 'para', text: '$$ is the pid\nof the shell' },
    { kind: 'heading', level: 1, text: 'Heading' }
  ])
  assert.deepEqual(blocks('$$\nx = 1'), [{ kind: 'para', text: '$$\nx = 1' }])
  assert.deepEqual(blocks('$$$$'), [{ kind: 'para', text: '$$$$' }])
  assert.deepEqual(blocks('$$x$$ and more text'), [{ kind: 'para', text: '$$x$$ and more text' }])
  // Nested in a list item.
  const list = blocks('1. Solve:\n\n   $$\n   x = 2\n   $$\n2. Done')[0]
  assert.equal(list.kind, 'list')
  assert.deepEqual((list as Extract<typeof list, { kind: 'list' }>).items[0].children, [{ kind: 'math', src: 'x = 2' }])
})

test('a half-written display formula is text until its closing line arrives', () => {
  const partial = parseMarkdown('Intro.\n\n$$\n\\sum_{i=1}^n i')
  assert.deepEqual(partial.blocks[1], { kind: 'para', text: '$$\n\\sum_{i=1}^n i' })
  const done = parseMarkdown('Intro.\n\n$$\n\\sum_{i=1}^n i\n$$', partial)
  assert.deepEqual(done.blocks[1], { kind: 'math', src: '\\sum_{i=1}^n i' })
})

test('KaTeX is told not to trust the LaTeX, and cannot be made to draw something enormous', () => {
  const link = renderMath(katex, '\\href{javascript:alert(1)}{click}', false)
  assert.ok(link === null || !/<a[\s>]|href=/.test(link))
  assert.doesNotMatch(renderMath(katex, '\\includegraphics{https://example.com/x.png}', false) ?? '', /<img|src=/)
  // A rule a hundred thousand ems wide is drawn fifty wide.
  const rule = renderMath(katex, '\\rule{100000em}{1em}', false) ?? ''
  assert.match(rule, /border-right-width:50em/)
  assert.doesNotMatch(rule, /border-right-width:100000em/)
  assert.equal(renderMath(katex, 'x'.repeat(8001), false), null)
  assert.equal(renderMath(katex, '   ', false), null)
  assert.equal(renderMath(katex, '\\badcommand', false), null)
  assert.match(renderMath(katex, 'a^2+b^2', false) ?? '', /class="katex"/)
  // Markup in the formula's text is escaped.
  assert.doesNotMatch(renderMath(katex, '\\text{<img src=x onerror=alert(1)>}', false) ?? '', /<img/)
})
