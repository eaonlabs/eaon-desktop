/**
 * Which Eaon CLI this is: its npm package and version, which
 * scripts/build-cli.mjs takes from cli/package.json. The CLI is a beta while
 * its version carries a beta tag (0.1.0-beta.1); the header, `--help` and
 * the update popup say so.
 */

declare const __EAON_CLI_VERSION__: string
declare const __EAON_CLI_PACKAGE__: string

export const CLI_VERSION = typeof __EAON_CLI_VERSION__ === 'string' ? __EAON_CLI_VERSION__ : '0.0.0-dev'
export const CLI_PACKAGE = typeof __EAON_CLI_PACKAGE__ === 'string' ? __EAON_CLI_PACKAGE__ : 'eaon'
export const CLI_BETA = /-beta(\.|$)/.test(CLI_VERSION)
