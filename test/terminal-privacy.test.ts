import { test } from 'node:test'
import assert from 'node:assert/strict'
import { privacyBlockedMessage } from '@shared/terminals'

/**
 * A terminal in a folder macOS keeps Eaon out of (Privacy & Security → Files
 * and Folders) says which switch lets it in, instead of a shell where Homebrew
 * says "the current working directory must be readable" and Claude Code fails
 * with "An unknown error occurred (Unexpected)".
 */

test('the message names the switch for Downloads, Documents and the Desktop', () => {
  const home = '/Users/al'
  assert.match(privacyBlockedMessage('/Users/al/Downloads/Eaon ADE/EaonADE', home), /turn on Eaon → Downloads Folder/)
  assert.match(privacyBlockedMessage('/Users/al/Documents/site', home), /Documents Folder/)
  assert.match(privacyBlockedMessage('/Users/al/Desktop', `${home}/`), /Desktop Folder/)
  // Anywhere else (iCloud Drive, another disk): access to the folder, or Full Disk Access.
  assert.match(privacyBlockedMessage('/Volumes/Work/site', home), /Full Disk Access/)
  assert.match(privacyBlockedMessage('/Users/al/Downloads-old/x', home), /Full Disk Access/, 'only the folder itself, not one that starts the same')
  for (const cwd of ['/Users/al/Downloads/x', '/Volumes/x']) assert.match(privacyBlockedMessage(cwd, home), /Privacy & Security → Files and Folders.*restart this terminal/)
})
