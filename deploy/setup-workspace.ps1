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

New-Item -ItemType Directory -Force -Path (Join-Path $WorkspaceRoot ".pi") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $WorkspaceRoot "lab-config") | Out-Null
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
	Set-Content -Path $Destination -Value $content -NoNewline
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
