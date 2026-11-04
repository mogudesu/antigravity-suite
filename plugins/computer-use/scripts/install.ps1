<#
.SYNOPSIS
  Install or uninstall the computer-use plugin for Antigravity on Windows.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Workspace C:\proj
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Workspace = "",
  [switch]$DryRun,
  [switch]$Force,
  [switch]$Uninstall,
  [switch]$UsePluginData
)

$ErrorActionPreference = "Stop"
$PluginName = "computer-use"

function Say($message) { Write-Host $message }

function Invoke-Step {
  param([string]$Display, [scriptblock]$Action)
  if ($DryRun) {
    Say ("  [dry-run] " + $Display)
  } else {
    & $Action
  }
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path

# --- find a Python 3 interpreter --------------------------------------------
function Find-Python {
  $candidates = @(
    @{ exe = "python";  pre = @() },
    @{ exe = "py";      pre = @("-3") },
    @{ exe = "python3"; pre = @() }
  )
  foreach ($candidate in $candidates) {
    $found = Get-Command $candidate.exe -ErrorAction SilentlyContinue
    if (-not $found) { continue }
    $probe = $candidate.pre + @("-c", "import sys; raise SystemExit(0 if sys.version_info[0]==3 else 1)")
    try {
      & $candidate.exe @probe 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { return $candidate }
    } catch {
      continue
    }
  }
  return $null
}

$python = Find-Python
if (-not $python) {
  Say "ERROR: no Python 3 interpreter found (looked for python, py -3, python3)."
  Say "Install Python 3 from python.org and tick 'Add python.exe to PATH'."
  exit 1
}
$pyVersion = (& $python.exe @($python.pre) @("-c", "import platform;print(platform.python_version())")).Trim()
Say ("interpreter: {0} {1} ({2})" -f $python.exe, ($python.pre -join " "), $pyVersion)

# --- validate the source plugin ---------------------------------------------
$manifestPath = Join-Path $PluginRoot "plugin.json"
if (-not (Test-Path $manifestPath)) {
  Say "ERROR: $PluginRoot does not look like a plugin (no plugin.json)."
  exit 1
}
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if ($manifest.name -ne $PluginName) {
  Say ("ERROR: plugin.json declares name '{0}', expected '{1}'." -f $manifest.name, $PluginName)
  exit 1
}
Say ("plugin     : {0} {1}  (source: {2})" -f $manifest.name, $manifest.version, $PluginRoot)

# --- destination ------------------------------------------------------------
if ($Workspace -ne "") {
  $Dest = Join-Path $Workspace (Join-Path ".agents\plugins" $PluginName)
} else {
  $profileDir = [Environment]::GetFolderPath("UserProfile")
  if (-not $profileDir) { $profileDir = $env:USERPROFILE }
  $Dest = Join-Path $profileDir (Join-Path ".gemini\config\plugins" $PluginName)
}
Say ("target     : {0}" -f $Dest)

if ($Uninstall) {
  if (-not (Test-Path $Dest)) {
    Say "nothing to uninstall at $Dest"
    exit 0
  }
  $installedManifest = Join-Path $Dest "plugin.json"
  if (-not (Test-Path $installedManifest)) {
    Say "REFUSING: $Dest has no plugin.json; remove it by hand if you are sure."
    exit 1
  }
  $installedName = (Get-Content $installedManifest -Raw | ConvertFrom-Json).name
  if ($installedName -ne $PluginName) {
    Say ("REFUSING: {0} contains plugin '{1}', not '{2}'." -f $Dest, $installedName, $PluginName)
    exit 1
  }
  Invoke-Step "Remove-Item -Recurse -Force '$Dest'" { Remove-Item -Path $Dest -Recurse -Force }
  Say "uninstalled. Policy files and audit logs were left in place:"
  Say ("  {0}" -f (Join-Path $env:LOCALAPPDATA $PluginName))
  exit 0
}

if ((Test-Path $Dest) -and (-not $Force)) {
  Say "ERROR: $Dest already exists. Re-run with -Force to overwrite it."
  exit 1
}

# --- copy -------------------------------------------------------------------
Invoke-Step "create '$Dest'" { New-Item -ItemType Directory -Force -Path $Dest | Out-Null }
if ($Force -and (Test-Path $Dest)) {
  Invoke-Step "clear '$Dest'" { Get-ChildItem -Path $Dest -Force | Remove-Item -Recurse -Force }
}
Invoke-Step "copy plugin files" {
  Copy-Item -Path (Join-Path $PluginRoot "*") -Destination $Dest -Recurse -Force
  Get-ChildItem -Path $Dest -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

# --- point the copy at this machine's interpreter ---------------------------
$configureTarget = if ($DryRun) { $PluginRoot } else { $Dest }
$configureArgs = @(
  (Join-Path $PluginRoot "scripts\configure.py"),
  "--plugin-dir", $configureTarget,
  "--command", $python.exe
)
if ($python.pre.Count -gt 0) { $configureArgs += @("--pre-args", ($python.pre -join " ")) }
if ($UsePluginData) { $configureArgs += "--use-plugin-data" }
if ($DryRun) { $configureArgs += "--dry-run" }
& $python.exe @($python.pre) @configureArgs
if ($LASTEXITCODE -ne 0) {
  Say "ERROR: configuring the installed copy failed."
  exit 1
}

# --- handshake check against the installed copy -----------------------------
if (-not $DryRun) {
  Say ""
  Say "handshake check:"
  $serverScript = Join-Path $Dest "scripts\mcp_server.py"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $python.exe
  $psi.Arguments = ((@($python.pre) + @('"' + $serverScript + '"')) -join " ")
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables["PYTHONDONTWRITEBYTECODE"] = "1"
  $proc = [System.Diagnostics.Process]::Start($psi)
  $payload = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}'
  $proc.StandardInput.WriteLine($payload)
  $proc.StandardInput.Close()
  $line = $proc.StandardOutput.ReadLine()
  $errText = $proc.StandardError.ReadToEnd()
  if (-not $proc.WaitForExit(15000)) { $proc.Kill() }
  if ($line -and ($line -match [regex]::Escape($PluginName))) {
    Say "  OK: the installed server completed an MCP handshake."
  } else {
    Say "  FAILED: no valid handshake. stderr:"
    Say ("    " + $errText)
    exit 1
  }
}

Say ""
Say "done. Next:"
Say "  1. restart Antigravity (or reload plugins) so it picks up the new plugin"
Say "  2. ask it to call computer-use_desktop_get_environment"
Say "  3. review the policy file in the plugin data directory before letting it click anything"
