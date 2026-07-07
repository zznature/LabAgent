param(
	[Parameter(Mandatory = $true)]
	[string]$WorkspacePath
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LabAgentsRepo = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$WorkspaceRoot = (Resolve-Path $WorkspacePath).Path
$PiBin = Join-Path $LabAgentsRepo "node_modules/.bin/pi.cmd"
$AppendSystemPrompt = Join-Path $LabAgentsRepo "src/prompts/APPEND_SYSTEM.md"

if (-not (Test-Path $PiBin)) {
	throw "Missing local pi binary: $PiBin. Run npm install --ignore-scripts in $LabAgentsRepo first."
}

if (-not (Test-Path (Join-Path $WorkspaceRoot ".pi/settings.json"))) {
	throw "Missing workspace settings: $WorkspaceRoot/.pi/settings.json"
}

if (-not (Test-Path (Join-Path $WorkspaceRoot ".pi/labagents-policy.json"))) {
	throw "Missing workspace policy: $WorkspaceRoot/.pi/labagents-policy.json"
}

Push-Location $WorkspaceRoot
try {
	& $PiBin --append-system-prompt $AppendSystemPrompt
	exit $LASTEXITCODE
} finally {
	Pop-Location
}
