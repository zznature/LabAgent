param(
	[Parameter(Mandatory = $true)]
	[string]$WorkspacePath
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LabAgentsRepo = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WorkspaceRoot = (Resolve-Path $WorkspacePath).Path
$DriverSrc = Join-Path $LabAgentsRepo "src/drivers/raman-python"
$DriverRoot = Join-Path $WorkspaceRoot "lab-config/drivers"
$DriverDst = Join-Path $DriverRoot "raman-python"

if (-not (Test-Path $DriverSrc)) {
	throw "Missing Raman Python driver source: $DriverSrc"
}

if (-not (Test-Path (Join-Path $WorkspaceRoot "lab-config"))) {
	throw "Missing workspace lab-config directory: $WorkspaceRoot/lab-config"
}

New-Item -ItemType Directory -Force -Path $DriverRoot | Out-Null

$ResolvedDriverRoot = (Resolve-Path $DriverRoot).Path
$ResolvedDriverDstParent = (Resolve-Path (Split-Path -Parent $DriverDst)).Path
if ($ResolvedDriverDstParent -ne $ResolvedDriverRoot) {
	throw "Refusing to sync driver outside workspace driver root: $DriverDst"
}

if (Test-Path $DriverDst) {
	Remove-Item -Recurse -Force -Path $DriverDst
}

Copy-Item -Recurse -Path $DriverSrc -Destination $DriverDst
Get-ChildItem -Path $DriverDst -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force
Get-ChildItem -Path $DriverDst -Recurse -File -Filter "*.pyc" | Remove-Item -Force

Write-Output "Raman Python driver synced: $DriverDst"
