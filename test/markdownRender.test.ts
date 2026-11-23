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
  assert.match(out, /<h4 class="md__heading" data-level="2">Disk usage<\/h4>/)
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
  // Spaced asterisks are arithmetic, not emphasis.
  assert.doesNotMatch(html('2 * 3 * 4 = 24'), /<em>/)
  assert.match(html('a *really* good idea'), /<em>really<\/em>/)
  assert.match(html('*two words*'), /<em>two words<\/em>/)
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

test("links to GitHub carry GitHub's mark, and a bare address says what it points at", () => {
  const out = html(
    [
      'Validate link targets. ([files.ts](https://github.com/acme/sdk/blob/main/src/files.ts))',
      'Staging uses 0755 ([line 75](https://github.com/acme/sdk/blob/62a60a5/src/upload.ts#L75)).',
      'Opened https://github.com/acme/sdk/pull/12 and [lines 428–431](https://github.com/acme/sdk/blob/main/src/tar.ts#L428-L431).',
      'Fixed in https://github.com/acme/sdk/commit/62a60a5f00d1. Not GitHub: https://example.com/a.'
    ].join('\n')
  )
  const links = [...out.matchAll(/<a [^>]*class="md__gh"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1].replace(/<svg[\s\S]*?<\/svg>/, '').replace(/<[^>]+>/g, ''))
  assert.deepEqual(links, ['files.ts', 'line 75', 'acme/sdk#12', 'lines 428–431', '62a60a5'])
  // Each with the mark, and the whole address in its tooltip.
  assert.equal(out.match(/class="md__gh-mark"/g)?.length, 5)
  assert.match(out, /title="https:\/\/github.com\/acme\/sdk\/pull\/12"/)
  assert.match(out, /<a href="https:\/\/example.com\/a">https:\/\/example.com\/a<\/a>/)
  // The mark keeps to the label's first word, so a line never ends on the mark alone.
  assert.match(out, /<span class="md__gh-lead"><svg[^>]*>[\s\S]*?<\/svg>lines<\/span> 428–431<\/a>/)
  assert.match(html('<https://github.com/acme/sdk/blob/main/src/tar.ts#L428-L431>'), /tar.ts:428–431/)
  // A branch keeps its slashes.
  assert.match(html('CI: https://github.com/acme/sdk/tree/fix/extract-links'), /fix\/extract-links<\/span><\/a>/)
})

test("a link's label holds no link of its own", () => {
  // A path in backticks would be a file link anywhere else; inside a link it is the label's code.
  const out = html('See [`src/files.ts:75`](https://github.com/acme/sdk/blob/main/src/files.ts#L75).')
  assert.equal(out.match(/<a /g)?.length, 1)
  assert.match(out, /<code class="md__code">src\/files.ts:75<\/code><\/span><\/a>/)
})
