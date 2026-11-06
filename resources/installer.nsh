; Added to the Windows installer by electron-builder (resources/ is its
; buildResources folder).

; Uninstalling Eaon takes out tokn's background sync (main/features/toknJob.ts),
; which would otherwise go on starting an Eaon.exe that isn't there every 15
; minutes. Not on an update, which uninstalls the old version first: the new
; one keeps the task, and puts it back in line at its first start.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec 'schtasks /Delete /TN "Eaon Tokn sync" /F'
    Pop $0
  ${endIf}
!macroend
