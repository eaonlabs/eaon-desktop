// Custom electron-builder Windows sign hook (win.signtoolOptions.sign).
//
// There is no local certificate here — the private key never leaves Azure's
// HSM. Signing means handing the file to Microsoft's `sign` CLI (`dotnet tool
// install --global sign`), which hashes it locally and has Azure Artifact
// Signing sign the hash remotely. electron-builder calls this once per file
// that needs a signature: the packaged app's .exe and, for the nsis target,
// the installer .exe.
//
// Authentication is whatever `az login` session is active on the machine —
// deliberately not a hardcoded service principal secret, matching how
// notarization credentials come from the keychain rather than this repo.
// The signed-in account must hold the "Trusted Signing Certificate Profile
// Signer" role on the eaon-signing account's eaon-desktop certificate profile.
//
// WIN_SIGN_PUBLISHER_NAME is read from the environment rather than hardcoded
// for the same reason the mac config never hardcodes CSC_NAME: this repo is
// public, and the certificate subject's Common Name is the signing
// individual's legal name.

const { execFileSync } = require('node:child_process')

const ENDPOINT = 'https://eus.codesigning.azure.net/'
const ACCOUNT = 'eaon-signing'
const CERTIFICATE_PROFILE = 'eaon-desktop'
const DESCRIPTION_URL = 'https://eaon.dev'

exports.default = async function sign(configuration) {
  const publisherName = process.env.WIN_SIGN_PUBLISHER_NAME
  if (!publisherName) {
    throw new Error('WIN_SIGN_PUBLISHER_NAME is not set — see scripts/release-windows.sh.')
  }

  execFileSync(
    'sign',
    [
      'code',
      'trusted-signing',
      configuration.path,
      '--trusted-signing-endpoint',
      ENDPOINT,
      '--trusted-signing-account',
      ACCOUNT,
      '--trusted-signing-certificate-profile',
      CERTIFICATE_PROFILE,
      '--publisher-name',
      publisherName,
      '--description',
      'Eaon',
      '--description-url',
      DESCRIPTION_URL,
      '--azure-credential-type',
      'azure-cli',
      '--file-digest',
      'sha256',
      '--timestamp-url',
      'http://timestamp.acs.microsoft.com'
    ],
    { stdio: 'inherit' }
  )
}
