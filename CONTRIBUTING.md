# Contributing to Eaon

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Report a bug or ask for a feature

Search the [issues](https://github.com/eaonlabs/eaon-desktop/issues) first; someone may have
reported it already. If not, open a new issue with the **Bug report** or **Feature request**
form. For a bug, say which version of Eaon you're on (Settings → General), your operating
system, and the steps that make it happen.

Don't paste API keys, tokens or personal details into an issue. Logs and screenshots can
contain them, so check before you attach one.

Found a security problem? Report it privately as [SECURITY.md](SECURITY.md) describes, not in
a public issue.

## Set up

You need Node.js 22 and git. Then:

```bash
git clone https://github.com/eaonlabs/eaon-desktop.git
cd eaon-desktop
npm install
npm run dev
```

`npm run dev` starts Eaon with hot reloading. The [Develop](README.md#develop) section of the
README lists the other build commands and how the source is laid out.

## Make a change

- Branch from `main`, and keep each pull request to one change. A big change is easier to get
  in if you open an issue about it first.
- Write code that reads like the code around it: TypeScript, single quotes, no semicolons, and
  comments that say why rather than what.
- Add or update tests with the change. Main-process tests are `test/*.test.ts`; end-to-end
  scenarios are `test/e2e/*.e2e.mjs` and drive the built app against a fake model server.
  Tests must never call a real provider or spend money.
- If people using Eaon will notice the change, add a line to [CHANGELOG.md](CHANGELOG.md)
  under an `## [Unreleased]` heading at the top (add the heading if it isn't there).
- Keep keys, tokens and personal details out of code, tests, fixtures and screenshots.

## Check it

```bash
npm run typecheck
npm run test:main                # every main-process test
npm run test:main -- anthropic   # only test files whose name contains "anthropic"
npm run test:e2e                 # the built app end to end (builds first if needed)
```

On Linux the end-to-end suite needs a display; run it under `xvfb-run`. Pull requests run the
end-to-end suite on Linux automatically, and changes to `src/`, `scripts/` or the package files
also build and test the Windows installer.

## Open a pull request

Fill in the template: what changed and why, how you tested it, and a screenshot for anything
visible. Link the issue it fixes ("Fixes #123"). A maintainer will review it; expect questions
and small change requests before it's merged.

## Licence

Eaon is under the [Apache License 2.0](LICENSE.md). Anything you contribute is under the same
licence, as section 5 of the licence says.

## Code of conduct

Everyone taking part in Eaon's community is expected to follow the
[code of conduct](CODE_OF_CONDUCT.md).
