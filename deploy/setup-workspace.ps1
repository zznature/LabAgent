param(
	[Parameter(Mandatory = $true)]
	[string]$WorkspacePath
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LabAgentsRepo = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$TemplateRoot = Join-Path $LabAgentsRepo "deploy/templates/lab-workspace"
New-Item -ItemType Directory -Force -Path $WorkspacePath | Out-Null
$WorkspaceRoot = (Resolve-Path $WorkspacePath).Path
$DefaultPiRepo = Join-Path (Split-Path -Parent $LabAgentsRepo) "pi"
$PiRepo = if ($env:PI_REPO) { (Resolve-Path $env:PI_REPO).Path } elseif (Test-Path $DefaultPiRepo) { (Resolve-Path $DefaultPiRepo).Path } else { $DefaultPiRepo }
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

New-Item -ItemType Directory -Force -Path (Join-Path $WorkspaceRoot ".pi") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $WorkspaceRoot "lab-config") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $WorkspaceRoot "lab-config/templates") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $WorkspaceRoot "lab-records") | Out-Null

function Render-Template {
	param(
		[string]$Source,
		[string]$Destination
	)
	$content = Get-Content -Raw -Path $Source
	$content = $content.Replace("{{LABAGENTS_REPO}}", $LabAgentsRepo.Replace("\", "/"))
	$content = $content.Replace("{{WORKSPACE_ROOT}}", $WorkspaceRoot.Replace("\", "/"))
	$content = $content.Replace("{{PI_REPO}}", $PiRepo.Replace("\", "/"))
	[System.IO.File]::WriteAllText($Destination, $content, $Utf8NoBom)
}

Render-Template `
	-Source (Join-Path $TemplateRoot ".pi/settings.json.template") `
	-Destination (Join-Path $WorkspaceRoot ".pi/settings.json")
Render-Template `
	-Source (Join-Path $TemplateRoot ".pi/labagents-policy.json.template") `
	-Destination (Join-Path $WorkspaceRoot ".pi/labagents-policy.json")
Render-Template `
	-Source (Join-Path $TemplateRoot "lab-config/raman-runtime.lab.json.template") `
	-Destination (Join-Path $WorkspaceRoot "lab-config/raman-runtime.lab.json")

# Dev mode: disable the guardrail extension for this workspace. Used when the
# workspace is nested inside the product repo, where the default protectedRoot
# (the repo itself) would otherwise block all workspace access. The policy file
# is still rendered so run-labagents.ps1's presence check passes; it is simply
# unused without the guardrail extension.
if ($env:LABAGENTS_DEV -eq "1") {
	$settingsPath = Join-Path $WorkspaceRoot ".pi/settings.json"
	$lines = Get-Content -Path $settingsPath | Where-Object { $_ -notmatch "guardrail" }
	[System.IO.File]::WriteAllText($settingsPath, ($lines -join [Environment]::NewLine), $Utf8NoBom)
}

$LocalConfig = Join-Path $WorkspaceRoot "lab-config/raman-runtime.local.json"
if (-not (Test-Path $LocalConfig)) {
	Copy-Item `
		-Path (Join-Path $TemplateRoot "lab-config/raman-runtime.local.json.example") `
		-Destination $LocalConfig
}

$UserPrompts = Join-Path $WorkspaceRoot "lab-config/user-prompts.md"
if (-not (Test-Path $UserPrompts)) {
	Copy-Item `
		-Path (Join-Path $TemplateRoot "lab-config/user-prompts.md") `
		-Destination $UserPrompts
}

$TemplateSourceRoot = Join-Path $TemplateRoot "lab-config/templates"
$TemplateDestinationRoot = Join-Path $WorkspaceRoot "lab-config/templates"
if (Test-Path $TemplateSourceRoot) {
	Get-ChildItem -Path $TemplateSourceRoot -File -Filter "*.json" | ForEach-Object {
		$destination = Join-Path $TemplateDestinationRoot $_.Name
		if (-not (Test-Path $destination)) {
			Copy-Item -Path $_.FullName -Destination $destination
		}
	}
}

# Refresh the deployed Raman Python driver copy from product source.
$DriverSrc = Join-Path $LabAgentsRepo "src/drivers/raman-python"
$DriverDst = Join-Path $WorkspaceRoot "lab-config/drivers/raman-python"
if (Test-Path $DriverDst) {
	Remove-Item -Recurse -Force -Path $DriverDst
}
New-Item -ItemType Directory -Force -Path (Join-Path $WorkspaceRoot "lab-config/drivers") | Out-Null
Copy-Item -Recurse -Path $DriverSrc -Destination $DriverDst
Get-ChildItem -Path $DriverDst -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force
Get-ChildItem -Path $DriverDst -Recurse -File -Filter "*.pyc" | Remove-Item -Force

Write-Output "Workspace prepared: $WorkspaceRoot"
