# cdp-bridge

CLI 工具，让 agent / 脚本通过 CDP 驱动 Chrome——优先连接你日常 Chrome（attach 模式，登录态全在），fallback 到独立 sidecar Chrome（spawn 模式）。

## 两种模式

**attach 模式（v0.2 默认）**——CDP 连接你日常 Chrome（端口 9222）。
- 优点：复用你的所有 cookie / 登录态 / 扩展 / 代理，**没有 ABE 限制**（同 Chrome 实例，同 ABE key）
- 限制：你 Chrome 启动时必须带 `--remote-debugging-port=9222`。`cdpb setup-shortcut` 改你 Chrome 快捷方式实现一次性配置
- cdpb 操作发生在你日常 Chrome 内，但用 background tab，不抢你的焦点

**spawn 模式（v0.1 行为，保留）**——启一个独立 sidecar Chrome（端口 9223）+ 复制 profile 到 `~/.cdp-bridge/chrome-profile/`。
- 优点：完全独立，不动你日常 Chrome
- 限制：Chrome 127+ ABE 让 cookie 跨实例不可解密，每个网站 sidecar 里要重登一次
- 用 `cdpb launch --spawn` 显式触发

## Tech Stack
- Node.js 22+（内置 fetch、WebSocket）
- 纯 ESM
- 零 npm 依赖（CDP 走原生 ws/fetch，避免装包卡死）
- Windows 优先；Mac/Linux 后续

## Constraints（约束先行，不要违反）
1. **绝不操作用户日常 Chrome 进程**——只启动 sidecar，不杀不重启用户 Chrome
2. **profile 拷贝是只读快照**——只复制不监听变更，不双向同步（避免冲突）
3. **CDP 端口绑 127.0.0.1**——不暴露到局域网；启动参数 `--remote-debugging-port=<port> --remote-debugging-address=127.0.0.1`
4. **side-effects 集中**：所有 sidecar 数据放在 `~/.cdp-bridge/`，方便清理
5. **状态最小化**：CLI 是无状态的，每次跑现读 `~/.cdp-bridge/state.json` 拿 PID/port

## Conventions
- CLI 入口：`bin/cdpb.mjs`，作为 npm bin（package.json `bin` 字段）
- 子命令一个文件：`src/commands/<name>.mjs`，导出 `{ run(args) }`
- 公共能力放 `src/`：`chrome-manager.mjs`、`cdp-client.mjs`、`profile-sync.mjs`、`paths.mjs`、`logger.mjs`
- 错误走 `throw new Error(msg)`；CLI router 统一捕获、退码 1
- 日志走 `logger.mjs`，格式 `[cdpb] <message>`，不用 emoji

## Sidecar 数据结构
```
~/.cdp-bridge/
├─ chrome-profile/           # sidecar Chrome 用的 user-data-dir
│  └─ Default/...             # 从用户主 profile 选择性拷贝
├─ downloads/                 # cdpb fetch 默认下载位置
├─ state.json                 # { pid, port, profileSyncedAt }
└─ logs/                      # Chrome stderr / cdpb 自身日志
```

## profile 拷贝策略：首次同步 vs 增量

**关键约束**：Chrome 127+ 启用了 App-Bound Encryption (ABE)，**Cookie / Login Data / Web Data / Extension Cookies 是跨 Chrome 实例不可解密的**——文件可以拷过去，但 sidecar Chrome 解不开主 Chrome 加密的内容。文档全网都说"复制 profile 就能用"，那是 Chrome 127 之前的事。

应对方式：分两个清单。
- `INITIAL_WHITELIST` = `VISIBLE_STATE` + `ABE_PROTECTED`，**只在首次启动**（sidecar profile 目录为空）执行。复 ABE 文件无害（解不开就解不开，跟没复制一样）
- `RESYNC_WHITELIST` = `VISIBLE_STATE`，用于 `cdpb sync-profile`（和 `cdpb launch --resync`），**永远不再覆盖 ABE 文件**——如果再覆盖会把 sidecar 自己用了 ABE 加密好的本地登录态干掉

`VISIBLE_STATE`（不受 ABE 保护，任何时候安全拷贝）：
- `Local State`（顶层加密 key，跟 ABE 配合无害）
- `Default/Preferences`、`Default/Secure Preferences`
- `Default/Extensions/`、`Default/Local Extension Settings/`
- `Default/Local Storage/`
- `Default/Bookmarks`、`Default/Bookmarks.bak`
- `Default/Top Sites*`
- `Default/Favicons*`

`ABE_PROTECTED`（只在 initial 同步复制，resync 时跳过）：
- `Default/Network/`（Cookies）
- `Default/Login Data*`
- `Default/Web Data*`
- `Default/Extension Cookies*`

不拷贝：Cache/、Sessions/、History、Tabs/、Service Worker（占用大、可能触发 Crash Recovery 弹窗、暴露隐私）。

**用户首次使用流程**：
1. `cdpb launch` —— 首次同步，sidecar 启动后 Chrome 看起来基本像主 Chrome（有书签、扩展、搜索引擎），但所有网站登录态丢失（ABE 限制）
2. 用户在 sidecar 里登几次 claude.ai / GitHub / 其他需要的网站 —— sidecar 用自己的 ABE key 加密存
3. 之后 `cdpb stop && cdpb launch` —— 不再 resync，sidecar 自己 ABE 加密的登录态全部保留，下次仍登着

## 代理处理（关键）
- **不依赖 Chrome 自动读取系统代理**——实测发现 Chrome 对 LAN 上的代理（如 `192.168.10.124:7897`）自动检测有时不生效
- launch 时按以下优先级解析代理：
  1. 显式 CLI 参数 `--proxy <addr>` 或 `--proxy none`（disable）
  2. Windows 注册表 `HKCU\...\Internet Settings\ProxyServer`（在 `ProxyEnable=1` 时）
  3. 都没有则不设代理
- 通过 `--proxy-server=<addr>` 显式传给 Chrome，确定性最高
- 解析后的代理写入 state.json，`cdpb status` 可读

## CDP 客户端约定
- 走 WebSocket 直连 `ws://127.0.0.1:<port>/devtools/browser`
- 命令通过 JSON message：`{ id, method, params }`
- 用 `Target.createTarget` 开新 page，再连 `ws://127.0.0.1:<port>/devtools/page/<targetId>`

## 命令清单（v0.2）
- `cdpb launch [--attach|--spawn] [--port N] [--proxy A|none] [--resync] [--headless]`
  - 默认: attach 到 9222；连不上就报错并提示选项（不悄悄回退到 spawn）
  - `--spawn`: 显式 sidecar 模式
- `cdpb status`：read state.json，ping CDP，输出 `ready mode=attach|spawn ...` / `dead` / `attach-stale` / `stopped at=...` / `never-launched`
- `cdpb stop`：spawn 模式杀进程；attach 模式只清 state.json，**永远不杀你日常 Chrome**
- `cdpb setup-shortcut [--dry-run] [--revert] [--include-registry]`：改你 Chrome 快捷方式加 CDP 启动参数
- `cdpb sync-profile [--full]`：（仅 spawn 模式有意义）从主 profile 刷新到 sidecar profile
- `cdpb fetch <url> [-o <path>]`：通过当前 Chrome 下载（background tab，不抢焦点）
- `cdpb install-skill <github-repo>`：fetch zip → 解压 → `npx skills add <local-dir>`

## 命令清单（v1+ 留 TODO）
- `cdpb exec <js>`：在新 tab 跑 JS 取返回值（替代 web-access /eval）
- `cdpb screenshot <url> -o <path>`
- `cdpb tab list/new/close`
- macOS / Linux 支持

## 关键风险（用户已知会接受）
1. **Chrome 顶部黄条警告**"Chrome 正在被自动测试软件控制"——CDP 必然出现（attach 和 spawn 都会有），无法消除
2. **同机其他进程能控制 Chrome**——CDP 端口虽绑 127.0.0.1 仍是本机内信任，禁止在公共电脑跑
3. **attach 模式：cdpb fetch 期间 download path 被改**——`Browser.setDownloadBehavior` 是浏览器范围的；下载完会立刻 restore 到 default。期间用户手动触发的下载也会进我们的 staging 目录，约 30 秒~2 分钟的窗口
4. **attach 模式：用户必须从带 `--remote-debugging-port=9222` 的入口启 Chrome**——快捷方式经 `setup-shortcut` 改过的能用；通过文件双击或 `start chrome` 命令打开的没有这些标志（除非也跑 `--include-registry`）

## Deferred / Won't-do
- ❌ 接管/重启用户日常 Chrome（attach 模式只是 _连接_，从不杀进程）
- ❌ Mac/Linux v0.x 不做（先 Windows 用着）
- ❌ MCP 服务形态（用户决定走 CLI；agent 通过 SKILL.md 调 cdpb 命令即可）
- ❌ 自动检测 Chrome Beta/Edge/Brave（只支持稳定版 Chrome）
- ❌ 修改 HKLM（系统级注册表）—— `--include-registry` 只动 HKCU 用户级
