---
name: cdp-bridge
description: 用 sidecar Chrome 突破慢网下载与登录壁垒。当需要下载 GitHub 大仓库 / 安装 npx skill / 抓需要登录态或代理才能拿到的资源时使用。本机有用户日常 Chrome 装着代理扩展、登录态、Cookie，cdp-bridge 启动一个独立 Chrome 副本，复用这些状态走 CDP 协议下载——既不打扰用户日常 Chrome，又能享受其网络配置。当用户提到"下载慢""装不上 skill""GitHub 抓不下来""要走我浏览器代理"时优先使用。
---

# cdp-bridge

让 agent / 脚本通过用户日常 Chrome 的 sidecar 副本下载文件、装 GitHub skill、读需登录的页面。命令行工具 `cdpb`，Node 22+，Windows 优先。

## 何时用

- 直接 curl/PowerShell 下 GitHub 大文件极慢（国内常见）
- 要装一个 `npx skills add <repo>` 的 skill 但 git clone 超时
- 抓的内容需要用户浏览器登录态或代理才能正常拿
- 想在 agent 里跑 JS 操作页面，但又不想动用户日常 Chrome 的 tab

## 快速判断

| 场景 | 用什么 |
|------|--------|
| 装 GitHub skill | `cdpb install-skill owner/repo -g` |
| 下任意 URL | `cdpb fetch <url> -o <path>` |
| 看 Chrome 是否就绪 | `cdpb status` |
| 启动 sidecar | `cdpb launch` |
| 关掉 sidecar | `cdpb stop` |
| 刷新书签/扩展（不动 cookies） | `cdpb stop && cdpb sync-profile` |
| 重置全部 profile（**会清登录态**） | `cdpb stop && cdpb sync-profile --full` |

## 标准流程

第一次用，按顺序跑这两条：

```
cdpb launch              # 拷贝 profile + 启 Chrome（首次约 30 秒，因为复制 ~260MB）
cdpb install-skill <repo> -g
```

之后只要 sidecar 还活着，直接跑后一条。

`cdpb launch` 是幂等的——已经在跑就不重启。Sidecar Chrome 在用户机器上一直开着没问题，关掉它只在你想清理时。

## 重要约束

1. **绝不主动操作用户日常 Chrome 进程**——只启自己的 sidecar
2. **第一次 launch 会复制用户 profile 关键文件**到 `~/.cdp-bridge/chrome-profile/`，约 350MB
3. **后续 launch 不再 auto-resync**——这样 sidecar 里的登录态不会被覆盖。手动刷新跑 `cdpb sync-profile`
4. **CDP 端口 9222 仅本机可达**——绑 127.0.0.1
5. **不能跑在公共/共享电脑上**——CDP 端口对本机所有进程开放，等同把 Chrome 控制权交给本机

## 关键限制：登录态不能从主 Chrome 拷过来

**Chrome 127+ 引入 App-Bound Encryption (ABE)**，Cookie/保存的密码/搜索引擎自动填充等加密 key 跟"Chrome 实例"绑定。即使是同一台机器、同一个 Windows 用户、同一个 chrome.exe 二进制，**sidecar 也无法解密主 Chrome 加密的 Cookie**。

这不是 cdp-bridge 的 bug，是 Google 故意设计的——防止恶意软件（包括"另一个 Chrome 进程"）偷 Cookie。

**实操**：

1. 第一次进 sidecar——书签、扩展、搜索引擎都有，但**所有网站显示未登录**（包括 claude.ai、GitHub、Gmail 等）
2. 在 sidecar 里登一次需要的网站——sidecar 用自己的 ABE key 加密存自己 profile
3. 之后 `cdpb stop && cdpb launch`——sidecar 自己加密的 Cookie 全部读得回，登录态保留

**用户问"为什么没同步登录"或"为什么要重新登录"时**，解释这个、然后让他登一次。**别建议** "试 `--full` 重新拷"——只会把刚登好的 sidecar Cookie 干掉。

## 代理（很重要）

cdpb launch 时自动读取 Windows 系统代理（`HKCU\...\Internet Settings`）并通过 `--proxy-server` 强制塞给 Chrome。这点跟 Chrome 默认的"自动读系统代理"不同——实测 Chrome 自动检测对 LAN 代理（如 `192.168.x.x:7890` 路由器/NAS 上的 Clash）有时不生效，所以我们显式传。

- 想强制走某个代理：`cdpb launch --proxy 127.0.0.1:7890`
- 想禁用代理（直连）：`cdpb launch --proxy none`
- 不传任何 `--proxy`：自动用系统代理

`cdpb status` 输出会显示当前用的代理。

如果用户说"下载慢"——先看 `cdpb status` 里的 proxy 字段。`proxy=none` 还在抱怨慢，问问用户系统代理是不是关了。

## 常见错误

- `sidecar Chrome not running. Run cdpb launch first.` → 跑 `cdpb launch`
- `chrome.exe not found in standard locations` → Chrome 装在非默认路径，目前 v1 不支持自定义
- `download timeout` → 网络真的太慢，或 URL 错误。先 `cdpb fetch <url>` 单独验证

## 用法示例

```powershell
# 装 huashu-design skill 全局
cdpb launch
cdpb install-skill alchaincyf/huashu-design -g

# 下载某个大文件到指定路径
cdpb fetch https://github.com/foo/bar/archive/refs/heads/main.zip -o D:\downloads\bar.zip

# 检查状态
cdpb status
# ready pid=12345 port=9222 product=Chrome/147.0.7727.138
```

## Agent 调用注意

Agent 在脚本里调用 `cdpb` 时：

- 如果 `cdpb status` 输出以 `ready ` 开头，可以直接跑 install-skill / fetch
- 如果输出 `never-launched` 或 `dead`，先跑 `cdpb launch`
- 各命令的 stdout 干净（结果路径、状态字符串）；过程日志在 stderr，前缀 `[cdpb]`
- 退码 0 = 成功，非 0 = 失败，错误信息在 stderr
