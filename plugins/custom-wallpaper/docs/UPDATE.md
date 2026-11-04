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

## 用户如何收到更新

插件加载后会自动检查一次 GitHub Release（之后每 6 小时检查一次）：

- 有新版本时，顶栏 `✦` 按钮出现金色小点，并提示“发现新版本”。
- 打开设置 →「星夜美化」→「更新」页，可查看版本与更新说明。
- 点击「立即更新」会：
  1. 下载 GitHub Release 的 zip
  2. 校验 `latest.json` 里的 SHA-256
  3. 备份当前插件到 `~/.gemini/memory/antigravity-theme-backups/`
  4. 替换插件文件
  5. 保留本地 `config/config.json`、自定义壁纸、`scripts/prompts-custom.json`、快照与更新源配置
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
