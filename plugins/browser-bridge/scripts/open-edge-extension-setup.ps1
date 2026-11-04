[CmdletBinding()]
param(
    [ValidateSet("edge", "chrome")]
    [string]$Browser = "edge",

    [string]$ExtensionPath = "",

    # 只打印将要执行的命令，不真正打开浏览器 / 资源管理器（用于自动化验证）
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$pluginRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ExtensionPath)) {
    $ExtensionPath = Join-Path $pluginRoot "extension"
}
$ExtensionPath = [System.IO.Path]::GetFullPath($ExtensionPath)
if (-not (Test-Path -LiteralPath $ExtensionPath -PathType Container)) {
    throw "扩展目录不存在：$ExtensionPath"
}

if ($Browser -eq "edge") {
    $candidates = @(
        "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    )
    $extensionsUrl = "edge://extensions/"
} else {
    $candidates = @(
        "C:\Program Files\Google\Chrome\Application\chrome.exe",
        "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
    )
    $extensionsUrl = "chrome://extensions/"
}

$exe = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $exe) {
    throw "找不到 $Browser 的可执行文件，候选路径：$($candidates -join ' | ')"
}

$explorerArg = '/select,"' + $ExtensionPath + '"'
$result = [pscustomobject]@{
    browser       = $Browser
    executable    = $exe
    extensionsUrl = $extensionsUrl
    extensionPath = $ExtensionPath
    commandLine   = '"' + $exe + '" ' + $extensionsUrl
    revealCommand = 'explorer.exe ' + $explorerArg
    dryRun        = [bool]$DryRun
}

if ($DryRun) {
    $result | ConvertTo-Json -Compress
    exit 0
}

Start-Process -FilePath $exe -ArgumentList @($extensionsUrl)
Start-Sleep -Milliseconds 700
Start-Process -FilePath "explorer.exe" -ArgumentList @($explorerArg)

try { Set-Clipboard -Value $ExtensionPath } catch { }

Write-Host ""
Write-Host "已打开 $extensionsUrl 并定位扩展目录（路径已尝试复制到剪贴板）。"
Write-Host "接下来：开启「开发人员模式」→ 点「加载解压缩的扩展」→ 选择："
Write-Host "  $ExtensionPath"
Write-Host "加载后点扩展图标，确认端口为 8765，再点「重连」。"
$result | ConvertTo-Json -Compress
