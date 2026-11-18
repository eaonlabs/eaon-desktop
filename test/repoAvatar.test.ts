import { test } from 'node:test'
import assert from 'node:assert/strict'
import { avatarSteps, ownerKey, ownerOfRemote } from '../src/shared/repoAvatar'

test('a remote’s owner is read from every way git spells it', () => {
  const github = { forge: 'github', owner: 'acme', namespace: 'acme' }
  assert.deepEqual(ownerOfRemote('https://github.com/acme/web.git'), github)
  assert.deepEqual(ownerOfRemote('https://github.com/acme/web'), github)
  assert.deepEqual(ownerOfRemote('git@github.com:acme/web.git'), github)
  assert.deepEqual(ownerOfRemote('ssh://git@github.com:22/acme/web.git'), github)
  assert.deepEqual(ownerOfRemote('ssh://git@ssh.github.com:443/acme/web.git'), github)
  // A second account's SSH alias, and a token in the URL (never kept).
  assert.deepEqual(ownerOfRemote('git@github.com-work:acme/web.git'), github)
  assert.deepEqual(ownerOfRemote('https://x-access-token:ghp_secret@github.com/acme/web.git'), github)
  assert.deepEqual(ownerOfRemote('https://github.com/acme/.github'), github)
  assert.deepEqual(ownerOfRemote('git@bitbucket.org:team-x/api.git'), { forge: 'bitbucket', owner: 'team-x', namespace: 'team-x' })
  assert.deepEqual(ownerOfRemote('https://codeberg.org/forgejo/forgejo.git'), { forge: 'codeberg', owner: 'forgejo', namespace: 'forgejo' })
})

test('GitLab keeps a repository’s subgroups; elsewhere the owner is the first part', () => {
  assert.deepEqual(ownerOfRemote('git@gitlab.com:gitlab-org/security/gitlab.git'), { forge: 'gitlab', owner: 'gitlab-org', namespace: 'gitlab-org/security' })
  assert.equal(ownerOfRemote('https://github.com/acme/web/extra')?.namespace, 'acme')
})

test('no owner for other hosts, local folders, or a path that isn’t owner/repository', () => {
  for (const remote of [
    null,
    '',
    'https://git.example.com/acme/web.git',
    '/Users/me/repos/web.git',
    'C:\\repos\\web',
    'file:///Users/me/web.git',
    'https://github.com/acme',
    'https://github.com/',
    'git@github.com:../web.git',
    'https://github.com/ac me/web'
  ])
    assert.equal(ownerOfRemote(remote), null, String(remote))
})

test('one picture per owner, whatever the case', () => {
  const a = ownerOfRemote('git@github.com:Acme/web.git')!
  const b = ownerOfRemote('https://github.com/acme/api')!
  assert.equal(ownerKey(a), ownerKey(b))
  assert.notEqual(ownerKey(a), ownerKey(ownerOfRemote('https://gitlab.com/acme/web')!))
})

test('where each forge is asked, and what its answer names', () => {
  assert.deepEqual(avatarSteps(ownerOfRemote('git@github.com:acme/web.git')!), [{ kind: 'image', url: 'https://github.com/acme.png?size=64' }])

  const gitlab = avatarSteps(ownerOfRemote('git@gitlab.com:gitlab-org/security/gitlab.git')!)
  assert.deepEqual(
    gitlab.map((step) => step.url),
    [
      'https://gitlab.com/api/v4/groups/gitlab-org%2Fsecurity?with_projects=false',
      'https://gitlab.com/api/v4/groups/gitlab-org?with_projects=false',
      'https://gitlab.com/api/v4/users?username=gitlab-org'
    ]
  )
  const [group, , user] = gitlab
  assert.ok(group.kind === 'json' && user.kind === 'json')
  assert.equal(group.pick({ avatar_url: 'https://gitlab.com/uploads/a.png' }), 'https://gitlab.com/uploads/a.png')
  assert.equal(group.pick({ avatar_url: null }), null)
  assert.equal(user.pick([{ avatar_url: 'https://secure.gravatar.com/avatar/x' }]), 'https://secure.gravatar.com/avatar/x')
  assert.equal(user.pick([]), null)

  const [bitbucket] = avatarSteps(ownerOfRemote('git@bitbucket.org:atlassian/x.git')!)
  assert.ok(bitbucket.kind === 'json')
  assert.equal(bitbucket.pick({ links: { avatar: { href: 'https://bitbucket.org/workspaces/atlassian/avatar/' } } }), 'https://bitbucket.org/workspaces/atlassian/avatar/')
})
