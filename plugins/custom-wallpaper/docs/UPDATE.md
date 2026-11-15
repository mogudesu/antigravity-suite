# 星夜美化插件：GitHub 发布与自动更新

## 一次性配置

1. 把插件目录推到 GitHub 仓库（仓库根目录就是本插件目录）。
2. 编辑 `config/update.json`，填写仓库：
   ```json
   {
     "repo": "你的用户名/仓库名",
     "manifestUrl": "",
     "assetName": "antigravity-starlight-mogu.zip",
     "autoCheck": true
   }
   ```
   如果不想用 GitHub API，也可以直接填 `manifestUrl` 指向任意 GitHub 上的 `latest.json`。
3. 修改 `plugin.json` 的 `version` 后打 tag：
   ```bash
   git tag v1.1.0
   git push origin v1.1.0
   ```
   `.github/workflows/release.yml` 会自动生成并上传：
   - `antigravity-starlight-mogu-<version>.zip`
   - `latest.json`（包含版本、zip 地址、SHA-256、更新说明）

## 套装发版（五件套）

一次 Release 需要五个插件包 + `latest.json`。`scripts/release.js` 会扫描同级插件目录（默认
`~/.gemini/config/plugins`，可用 `--plugins-dir` 指定）：

- `antigravity-starlight-mogu-<v>.zip`
- `antigravity-mnemon-<v>.zip`
- `antigravity-computer-use-<v>.zip`
- `antigravity-browser-bridge-<v>.zip`
- `antigravity-remote-mogu-<v>.zip`（独立 0.x 版本，含运行时 `node_modules`）

`latest.json` 顶层的 `name/version/zipUrl/sha256` 仍指向主题插件（兼容旧版更新器），
`components` 数组列出五个组件的版本、zip 地址与 SHA-256。远程插件的版本与套装 tag 无关，
例如套装 tag `v1.1.3` 里远程组件可以是 `0.1.0`。

```bash
# 本地打套装包（同级目录需有五个插件；远程插件先 install-plugin 同步）
node scripts/release.js --repo mogudesu/antigravity-suite --out dist
# 上传（也可在 GitHub Release 页面手动拖入 dist 下的文件）
gh release create v1.1.2 dist/*.zip dist/latest.json --notes "Antigravity Suite v1.1.2"
```

注意：GitHub Action 的仓库根目录只有主题插件，CI 只能打主题包；套装发版请在本地执行后上传。
⚠️ 仓库里的 Release Action 监听 `v*` tag，会在你发布 v1.1.2 时自动跑一遍并用**只有主题**的 `latest.json` 覆盖五件套清单。
发套装前先禁用该 workflow（`gh api -X PUT repos/mogudesu/antigravity-suite/actions/workflows/407930292/disable`），或把它改成手动触发；否则远程组件会从清单里消失。

## 用户如何收到更新

插件加载后会自动检查一次 GitHub Release（之后每 6 小时检查一次）：

- 有新版本时，顶栏 `✦` 按钮出现金色小点，并提示“发现 N 个插件可更新”。
- 打开设置 →「星夜美化」→「更新」页，会列出五个插件（美化 / 长期记忆 / 电脑控制 / 浏览器控制 / 远程）的已装版本与最新版本。
- 点击「全部更新」会逐个组件：
  1. 下载 GitHub Release 的 zip
  2. 校验 `latest.json` 里的 SHA-256 与包内 `plugin.json`
  3. 备份当前插件到 `~/.gemini/memory/antigravity-theme-backups/`
  4. 替换插件文件（浏览器控制、远程插件的 `node_modules` 随包替换）
  5. 保留本地 `config/config.json`、自定义壁纸、`scripts/prompts-custom.json`、快照与更新源配置；记忆、录制、审计等用户数据都在 `~/.gemini/memory/` 下，不受影响
- 远程插件不直接替换文件：星夜美化调用远程 hub 的 `/api/update/apply`，由它下载/校验/备份/替换并重启 hub；MCP 工具需重启 Antigravity 后刷新。
- 某个组件失败不会影响其他组件，状态里会列出失败项。
- 更新完成后重启 Antigravity 生效。更新不会静默执行，必须用户点击确认。

## 安全边界

- 只允许 HTTPS 的 `github.com`、`api.github.com` 和 `*.githubusercontent.com`。
- 更新包必须带 64 位 SHA-256，校验失败不会替换文件。
- 更新前完整备份；拒绝 zip 路径穿越、绝对路径和符号链接。
- 更新源为空时只显示“未配置”，不会发起网络请求。

## 本地测试

```bash
node scripts/update.js status
node scripts/update.js check
# 需要实际替换文件时：
node scripts/update.js apply
```

发布构建（不影响当前插件目录）：

```bash
node scripts/release.js --repo 你的用户名/仓库名 --out dist
```
