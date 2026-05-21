---
name: cdp-bridge
description: 用 CDP 驱动用户日常 Chrome 完成下载/抓取/装 skill 等任务。默认 attach 模式直接连接已带 --remote-debugging-port 启动的日常 Chrome，复用全部 cookie/登录态/扩展/代理；fallback 是 spawn 独立 sidecar Chrome。当用户提到"下载慢""装不上 skill""GitHub 抓不下来""要走我浏览器代理""操作我 Chrome""保持登录态"时使用。命令是 cdpb。
---

# cdp-bridge

CDP-based 浏览器自动化工具，命令行 `cdpb`，两种模式：
- **attach**（默认）：连接你日常 Chrome，所有登录态/cookie/扩展原生可用
- **spawn**：启独立 sidecar Chrome，profile 选择性拷贝（ABE 限制：每个网站要重登）

Node 22+，Windows 优先。

## 何时用

- 直接 curl/PowerShell 下 GitHub 大文件极慢（国内常见）
- 要装一个 `npx skills add <repo>` 的 skill 但 git clone 超时
- 抓的内容需要用户浏览器登录态或代理才能正常拿（**用 attach 模式**）
- 想在 agent 里跑 JS 操作页面（attach: 可以；spawn: 要先登录）

**先 `cdpb status` 看一下当前模式 / 是否 ready**——再决定后续操作。

## 快速判断

| 场景 | 用什么 |
|------|--------|
| 第一次配置 | `cdpb setup-shortcut` 改 Chrome 快捷方式，**完整关闭 Chrome 后从修改后的快捷方式重启**，再 `cdpb launch` |
| 装 GitHub skill | `cdpb install-skill owner/repo -g` |
| 下任意 URL | `cdpb fetch <url> -o <path>` |
| 看 Chrome 是否就绪 | `cdpb status` |
| 启动会话（默认 attach） | `cdpb launch` |
| 启动独立 sidecar（fallback） | `cdpb launch --spawn` |
| 关掉会话 | `cdpb stop`（attach 模式只清记录，不杀你 Chrome） |
| 刷新 sidecar 书签/扩展 | `cdpb sync-profile`（仅 spawn 模式有意义） |
| 截网页截图 | `cdpb screenshot <url> -o <path>` |
| 在页面跑 JS 取返回值 | `cdpb exec <url> '<js>'` |
| 查看/管理浏览器 tab | `cdpb tab list` / `cdpb tab new <url>` / `cdpb tab close <id>` |

## 标准流程（attach 模式）

**首次配置（仅一次）**：
```
cdpb setup-shortcut       # 改你 Chrome 快捷方式加 --remote-debugging-port=9222
# 用户操作：完全关闭 Chrome（所有窗口），从改过的快捷方式（如桌面 Chrome 图标）重新打开
cdpb launch               # 应该 attach 上去（不再要求 setup）
```

**之后日常**：
```
cdpb status               # 一眼看到 ready mode=attach
cdpb install-skill <repo> -g
```

每次 Chrome 重启后，重启的进程仍带 `--remote-debugging-port`（因为快捷方式改过了），`cdpb launch` 会自动 attach 上。

## 备选流程（spawn 模式）

不想改 Chrome 启动方式、或要在没装 Chrome 的环境跑：
```
cdpb launch --spawn       # 启独立 sidecar Chrome 在 9223 端口
# 在 sidecar 里手动登一次 claude.ai / GitHub / 别的需要的网站（一次性）
cdpb install-skill <repo> -g
```

## 重要约束

1. **绝不主动操作用户日常 Chrome 进程**——只连接（attach）或启自己的 sidecar（spawn）
2. **spawn 模式第一次 launch 会复制用户 profile 关键文件**到 `~/.cdp-bridge/chrome-profile/`，约 350MB
3. **后续 spawn launch 不再 auto-resync**——这样 sidecar 里的登录态不会被覆盖。手动刷新跑 `cdpb sync-profile`
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

- `no Chrome session ready. Run cdpb launch first.` → 跑 `cdpb launch`
- `chrome.exe not found in standard locations` → Chrome 装在非默认路径，v0.x 暂不支持自定义
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
# ready mode=attach port=9222 product=Chrome/147
```

## Agent 调用注意

Agent 在脚本里调用 `cdpb` 时：

- 如果 `cdpb status` 输出以 `ready ` 开头，可以直接跑 install-skill / fetch / screenshot / exec / tab
- 如果输出 `never-launched`、`dead`、`attach-stale` 或 `stopped`，先跑 `cdpb launch`
- `another cdpb command is running` → 有另一个 cdpb 命令正在跑，等它完成；如果是僵尸锁，手动删 `~/.cdp-bridge/.lock`
- 各命令的 stdout 干净（结果路径、状态字符串）；过程日志在 stderr，前缀 `[cdpb]`
- 退码 0 = 成功，非 0 = 失败，错误信息在 stderr
