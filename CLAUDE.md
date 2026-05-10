# cdp-bridge

CLI 工具，让 agent / 脚本能直接驱动你日常 Chrome 的 sidecar 副本（带你的代理、登录态、扩展），不污染你正在用的 Chrome。

> 核心问题：直接 curl/PowerShell 联网在国内常常很慢；用户日常 Chrome 装了代理扩展能正常上网；但 web-access skill 要求每次手动去 chrome://inspect 启用 CDP，麻烦。
> 解法：sidecar Chrome——拷贝必要的 profile 数据到独立目录，启动一个独立 Chrome 实例（带 CDP 端口），既复用代理/Cookie/扩展，又不打扰你正在用的 Chrome。

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

## 命令清单（v1）
- `cdpb launch`：拷贝 profile（如未拷过）→ 启 Chrome → 写 state.json
- `cdpb status`：读 state.json，ping CDP，输出 ready/dead/never-launched
- `cdpb stop`：关掉 sidecar Chrome
- `cdpb fetch <url> [-o <path>]`：用 sidecar Chrome 下载到 path（默认 ~/.cdp-bridge/downloads/）
- `cdpb install-skill <github-repo>`：fetch zip → 解压 → `npx skills add <local-dir>`

## 命令清单（v2 以后，留 TODO 不实现）
- `cdpb exec <js>`：在新 tab 跑 JS 取返回值（替代 web-access /eval）
- `cdpb sync-profile`：手动重新拷贝 profile（cookie 过期后）
- `cdpb screenshot <url> -o <path>`
- `cdpb tab list/new/close`

## 关键风险（用户已知会接受）
1. **Chrome 顶部黄条警告**"Chrome 正在被自动测试软件控制"——CDP 必然出现，无法消除
2. **同机其他进程能控制 sidecar Chrome**——CDP 端口虽绑 127.0.0.1 仍是本机内信任，禁止在公共电脑跑
3. **profile 拷贝不实时同步**——主 Chrome 里登录新网站、改了 Cookie，sidecar 不会跟着更新，需要 `cdpb sync-profile`（v2 才做）

## Deferred / Won't-do
- ❌ 接管/重启用户日常 Chrome（用户明确反对）
- ❌ Mac/Linux v1 不做（先 Windows 用着）
- ❌ MCP 服务形态（用户决定走 CLI；agent 通过 SKILL.md 调 cdpb 命令即可）
- ❌ 自动检测 Chrome Beta/Edge/Brave（v1 只支持稳定版 Chrome）
