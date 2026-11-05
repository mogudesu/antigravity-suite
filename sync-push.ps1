<#
.SYNOPSIS
    一键将本地运行中的 Antigravity 插件变更同步到本仓库，并自动提交推送到 GitHub。
.EXAMPLE
    .\sync-push.ps1 "更新星夜美化面板与图标"
#>
param(
    [string]$Message = "chore: sync plugins from local environment"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$LocalPluginsRoot = "$env:USERPROFILE\.gemini\config\plugins"
$RepoRoot = $PSScriptRoot
$PluginsDir = Join-Path $RepoRoot "plugins"

$Mapping = @(
    @{ Src = "Antigravity 星夜美化-mogu"; Dest = "custom-wallpaper" },
    @{ Src = "antigravity-browser-bridge"; Dest = "browser-bridge" },
    @{ Src = "antigravity computer use-mogu"; Dest = "computer-use" },
    @{ Src = "antigravity长期记忆-mogu"; Dest = "mnemon" }
)

Write-Host ">>> 正在从本地 Antigravity 插件目录同步最新代码..." -ForegroundColor Cyan

foreach ($item in $Mapping) {
    $srcPath = Join-Path $LocalPluginsRoot $item.Src
    $destPath = Join-Path $PluginsDir $item.Dest
    
    if (Test-Path $srcPath) {
        Write-Host "  -> 同步: $($item.Src) => $($item.Dest)" -ForegroundColor Gray
        robocopy $srcPath $destPath /MIR /XD "node_modules" "__pycache__" ".git" "snapshots" /XF "*.log" "*.tmp" "*.bak" ".sidecar-lock.json" "update-state.json" /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
    } else {
        Write-Warning "未找到本地路径: $srcPath"
    }
}

Set-Location $RepoRoot
git checkout HEAD -- plugins/computer-use/hooks.json 2>$null

Write-Host ">>> 检查 Git 变更状态..." -ForegroundColor Cyan
git status --short

$status = git status --porcelain
if ([string]::IsNullOrWhiteSpace($status)) {
    Write-Host "✓ 没有发现任何代码变更，工作区干净！" -ForegroundColor Green
    exit 0
}

Write-Host ">>> 正在暂存并提交代码..." -ForegroundColor Cyan
git add .
git commit -m $Message

Write-Host ">>> 正在推送到远程 GitHub 仓库..." -ForegroundColor Cyan
try {
    git push origin main
    Write-Host "✓ 推送成功！所有插件已更新至 GitHub！" -ForegroundColor Green
} catch {
    Write-Warning "自动推送失败，请检查网络或执行 git push origin main 手动推送。"
}
