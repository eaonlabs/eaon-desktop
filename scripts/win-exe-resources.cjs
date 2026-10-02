/**
 * electron-builder `afterPack` hook: stamps Eaon.exe with its icon and version
 * details on Windows builds.
 *
 * electron-builder normally does this with rcedit, which it runs through wine
 * when building on a Mac, and its bundled wine is an Intel binary. On an Apple
 * silicon Mac without Rosetta that fails ("bad CPU type in executable"), so
 * `win.signAndEditExecutable` is off and this does the same edit with resedit.
 * resedit is pure JavaScript, and it is what @electron/packager itself uses
 * for this job. Nothing is signed either way: these Windows builds are
 * unsigned.
 */
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const ResEdit = require('resedit')

/** "2026.6.0-beta.1" → [2026, 6, 0, 0]: Windows versions are four plain numbers. */
function numericVersion(version) {
  const parts = String(version).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0)
  while (parts.length < 4) parts.push(0)
  return parts.slice(0, 4)
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const info = context.packager.appInfo
  const exe = join(context.appOutDir, `${info.productFilename}.exe`)
  const executable = ResEdit.NtExecutable.from(readFileSync(exe))
  const resource = ResEdit.NtExecutableResource.from(executable)

  const icon = ResEdit.Data.IconFile.from(readFileSync(join(context.packager.projectDir, 'resources', 'icon.ico')))
  const group = ResEdit.Resource.IconGroupEntry.fromEntries(resource.entries)[0]
  if (!group) throw new Error(`No icon group in ${exe}`)
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    resource.entries,
    group.id,
    group.lang,
    icon.icons.map((item) => item.data)
  )

  const [versionInfo] = ResEdit.Resource.VersionInfo.fromEntries(resource.entries)
  if (!versionInfo) throw new Error(`No version info in ${exe}`)
  const [language] = versionInfo.getAllLanguagesForStringValues()
  const [major, minor, patch, build] = numericVersion(info.version)
  versionInfo.setFileVersion(major, minor, patch, build, language.lang)
  versionInfo.setProductVersion(major, minor, patch, build, language.lang)
  versionInfo.setStringValues(language, {
    FileDescription: info.description || info.productName,
    ProductName: info.productName,
    CompanyName: info.companyName || info.productName,
    LegalCopyright: info.copyright,
    InternalName: info.productFilename,
    OriginalFilename: `${info.productFilename}.exe`,
    // The full version, prerelease tag included, as rcedit sets it.
    FileVersion: info.version,
    ProductVersion: info.version
  })
  versionInfo.outputToResourceEntries(resource.entries)

  resource.outputResource(executable)
  writeFileSync(exe, Buffer.from(executable.generate()))
  console.log(`  • stamped icon and version ${info.version} into ${exe}`)
}
