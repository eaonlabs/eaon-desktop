import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffGitPath, gitPath, parseUnifiedDiff } from '../src/shared/adeReview'

/**
 * File names as `git diff` writes them: a tab after a name with a space on
 * the `---`/`+++` lines, nothing quoted on the `diff --git` line, and odd
 * characters C-quoted with octal UTF-8 bytes. Samples are git's own output.
 */

test('a name with a space loses the tab git writes after it', () => {
  const diff = [
    'diff --git a/my file.txt b/my file.txt',
    'index 1111111..2222222 100644',
    '--- a/my file.txt\t',
    '+++ b/my file.txt\t',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    ''
  ].join('\n')
  const [file] = parseUnifiedDiff(diff)
  assert.equal(file.path, 'my file.txt')
  assert.equal(file.status, 'modified')
  assert.equal(file.added, 1)
})

test('a binary file with a space in its name is named from the diff --git line', () => {
  const diff = ['diff --git a/assets/my logo.png b/assets/my logo.png', 'new file mode 100644', 'index 0000000..3333333', 'Binary files /dev/null and b/assets/my logo.png differ', ''].join('\n')
  const [file] = parseUnifiedDiff(diff)
  assert.equal(file.path, 'assets/my logo.png')
  assert.equal(file.binary, true)
  assert.equal(file.status, 'added')
})

test('a new file with a space, as `git diff --no-index /dev/null` shows it', () => {
  const diff = ['diff --git a/notes/to do.md b/notes/to do.md', 'new file mode 100644', 'index 0000000..4444444', '--- /dev/null', '+++ b/notes/to do.md\t', '@@ -0,0 +1 @@', '+x', ''].join('\n')
  const [file] = parseUnifiedDiff(diff)
  assert.equal(file.path, 'notes/to do.md')
  assert.equal(file.status, 'added')
})

test('a renamed file with spaces takes its new name', () => {
  const diff = ['diff --git a/old name.ts b/new name.ts', 'similarity index 100%', 'rename from old name.ts', 'rename to new name.ts', ''].join('\n')
  const [file] = parseUnifiedDiff(diff)
  assert.equal(file.path, 'new name.ts')
  assert.equal(file.oldPath, 'old name.ts')
  assert.equal(file.status, 'renamed')
})

test('C-quoted names are unquoted, octal bytes as UTF-8', () => {
  assert.equal(gitPath('"b/caf\\303\\251.md"'), 'b/café.md')
  assert.equal(gitPath('"b/tab\\there \\"q\\" back\\\\slash"'), 'b/tab\there "q" back\\slash')
  assert.equal(gitPath('b/plain.ts'), 'b/plain.ts')
  assert.equal(diffGitPath('diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"'), 'café.md')
  assert.equal(diffGitPath('diff --git a/src/x.ts b/src/x.ts'), 'src/x.ts')
  assert.equal(diffGitPath('diff --git a/a b/c b/a b/c'), 'a b/c', 'the same name both sides, even with " b/" in it')
  const [file] = parseUnifiedDiff(['diff --git "a/\\346\\227\\245\\346\\234\\254.txt" "b/\\346\\227\\245\\346\\234\\254.txt"', 'index 1..2 100644', 'Binary files "a/\\346\\227\\245\\346\\234\\254.txt" and "b/\\346\\227\\245\\346\\234\\254.txt" differ', ''].join('\n'))
  assert.equal(file.path, '日本.txt')
})
