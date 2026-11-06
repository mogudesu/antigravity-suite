<#
.SYNOPSIS
    一键将本仓库的 5 大插件安装/部署到本机 Antigravity 配置目录。
.EXAMPLE
    .\install.ps1
#>
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$LocalPluginsRoot = "$env:USERPROFILE\.gemini\config\plugins"
$RepoRoot = $PSScriptRoot
$PluginsDir = Join-Path $RepoRoot "plugins"

if (-not (Test-Path $LocalPluginsRoot)) {
    New-Item -ItemType Directory -Path $LocalPluginsRoot -Force | Out-Null
}

$Mapping = @(
    @{ Dest = "Antigravity 星夜美化-mogu"; Src = "custom-wallpaper" },
    @{ Dest = "antigravity-browser-bridge"; Src = "browser-bridge" },
    @{ Dest = "antigravity computer use-mogu"; Src = "computer-use" },
    @{ Dest = "antigravity长期记忆-mogu"; Src = "mnemon" },
    @{ Dest = "antigravity-remote-mogu"; Src = "remote" }
)

Write-Host ">>> 正在安装 Antigravity 全家桶插件到本地..." -ForegroundColor Cyan

foreach ($item in $Mapping) {
    $srcPath = Join-Path $PluginsDir $item.Src
    $destPath = Join-Path $LocalPluginsRoot $item.Dest
    
    if (Test-Path $srcPath) {
        Write-Host "  -> 部署: $($item.Src) => $($item.Dest)" -ForegroundColor Gray
        robocopy $srcPath $destPath /MIR /XD "node_modules" "__pycache__" ".git" /XF "*.log" "*.tmp" /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
    }
}

Write-Host "✓ 安装完成！请重启或刷新 Antigravity 查看已加载的插件！" -ForegroundColor Green
