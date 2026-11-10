# Eaon app control, Windows engine: compiles Engine.cs (UI Automation) and
# runs its line protocol on stdin/stdout. Started by
# src/main/features/appControl/platform.ts with Windows PowerShell 5.1,
# whose Add-Type compiles C# 5 against the .NET Framework that ships with
# Windows, so nothing is installed.

$ErrorActionPreference = 'Stop'
$source = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Engine.cs')
Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies @(
  'UIAutomationClient',
  'UIAutomationTypes',
  'WindowsBase',
  'System.Web.Extensions',
  'System.Core'
)
[EaonAppControl.Engine]::Run()
