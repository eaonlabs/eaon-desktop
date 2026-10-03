import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../src/renderer/src/components/agent/Markdown'

/** What the chat actually draws for a reply, as HTML. */
const html = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }))

test('a typical reply renders as Markdown, not as punctuation', () => {
  const out = html(
    [
      '## Disk usage',
      '',
      'Your Mac has **41 GB** of caches, __mostly__ in `~/Library/Caches`. It is _safe_ to clear ~~some~~ most of them.',
      '',
      '1. **Caches:** 41 GB',
      '   - Xcode: 30 GB',
      '   - Browsers: 11 GB',
      '',
      '2. **Mail:** 3 GB',
      '',
      '| Folder | Size |',
      '|---|--:|',
      '| Caches | 41 GB |',
      '',
      '- [x] Checked the disk',
      '- [ ] Clear caches (needs your OK)',
      '',
      'Details: https://support.apple.com/en-us/102624. See [the guide](https://example.com/guide).'
    ].join('\n')
  )
  assert.match(html('plain'), /<p class="md__p">plain<\/p>/)
  assert.match(out, /<h4 class="md__heading">Disk usage<\/h4>/)
  assert.match(out, /<strong>41 GB<\/strong>/)
  assert.match(out, /<strong>mostly<\/strong>/)
  assert.match(out, /<code class="md__code">~\/Library\/Caches<\/code>/)
  assert.match(out, /<em>safe<\/em>/)
  assert.match(out, /<del>some<\/del>/)
  // One numbered list, with the sub-bullets inside its first item.
  assert.equal(out.match(/<ol/g)?.length, 1)
  assert.match(out, /<li><strong>Caches:<\/strong> 41 GB<ul class="md__list"><li>Xcode: 30 GB<\/li><li>Browsers: 11 GB<\/li><\/ul><\/li>/)
  assert.match(out, /<div class="tbl" data-kind="data" role="table"/)
  assert.match(out, /<div class="tbl__cell" role="cell" style="justify-content:flex-end;text-align:right"><span class="tbl__text">41 GB<\/span><\/div>/)
  assert.match(out, /data-checked="true"/)
  assert.match(out, /<a href="https:\/\/support.apple.com\/en-us\/102624">https:\/\/support.apple.com\/en-us\/102624<\/a>\./)
  assert.match(out, /<a href="https:\/\/example.com\/guide">the guide<\/a>/)
  // No Markdown punctuation left in what the reader sees.
  assert.doesNotMatch(out.replace(/<[^>]+>/g, ''), /\*\*|__|~~|\|---/)
})

test('snake_case and stray symbols stay as written', () => {
  const out = html('Set max_tool_rounds to 2 * 3 and keep file_name_here.')
  assert.doesNotMatch(out, /<em>|<strong>/)
})

test("links that aren't web or mail addresses are shown as text, not opened", () => {
  const out = html('[click](javascript:alert(1)) and [file](file:///etc/passwd)')
  assert.doesNotMatch(out, /<a /)
})

test('a table of ticks and dashes is drawn as a comparison', () => {
  const out = html('| Feature | Personal | Team |\n|---|:-:|:-:|\n| Unlimited projects | ✓ | ✓ |\n| **Team-wide use** | No | Yes |')
  assert.match(out, /data-kind="comparison"/)
  assert.equal(out.match(/class="tbl__yes"/g)?.length, 3)
  assert.equal(out.match(/class="tbl__no"/g)?.length, 1)
  // The feature column keeps its Markdown.
  assert.match(out, /<strong>Team-wide use<\/strong>/)
})
