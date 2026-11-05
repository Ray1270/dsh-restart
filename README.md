# @ray1270/dsh-restart

给 DeepSeek Harness **桌面版**加两个常驻按钮，就在窗口顶栏「应用」「编辑」右边：

```
应用  编辑  刷新  重启
```

- **刷新** = 重新加载这个页面。Host 不动、会话记录不动、正在跑的 agent 也不动，只把这个 Web 客户端重新装一遍。加载完仍然停在你刚才那个会话。
- **重启** = 重启整个应用（Electron 壳 + Host）。点两下，2–4 秒后应用带着**你刚才那个会话**重新打开。

> 为什么需要它：桌面版的端口每次启动都是随机分配的（`--port 0`），所以每次重启等于换了一个 origin——旧页面失联、壳自动开新页面、你被扔回首页。想「重启一下看效果」原本要：关窗口 → 找图标 → 等启动 → 手动点回会话。
>
> 刷新则解决另一半问题：**客户端插件的改动**（slot 注册、界面代码）只需要重新加载页面就能生效，没必要为此重启 Host。但 DSH 的当前会话只活在页面里、不在 URL 上，手按 F5 会掉回首页——所以这个按钮顺手把会话也带回来了。

---

## 用起来是什么样

| 状态 | 顶栏显示 | 说明 |
| --- | --- | --- |
| 空闲 | `刷新` `重启` | 两个都是普通菜单项，样式与「应用」「编辑」一致 |
| 点「刷新」 | `刷新中` | 约 0.1 秒后整页重载；回到同一会话（2 分钟内有效） |
| 点「重启」第一次 | `确认重启` / `确认重启 · N 项` | 预检；N = 此刻会被中断的 agent / job / 终端数量；4 秒不点自动撤销 |
| 点「重启」第二次 | `重启中` | 1–3 秒后应用退出，随即自动拉起；回来时停在同一会话（30 分钟内有效） |
| 失败 | `重启失败` / `刷新失败` | 6 秒后复位；原因在 tooltip 里 |

**为什么刷新只要一下、重启要两下**：刷新不会杀掉任何服务端的东西（agent 继续跑、会话继续写），代价最大只是**输入框里没发出去的草稿**会丢——tooltip 里写明了。重启会真的中断活动任务，所以必须让人看清数字再决定。

顶栏那条菜单是桌面壳自己画的（`preload` 里的 shadow DOM），插件只能在它后面追加同级按钮——所以样式、字号、悬停、拖动区都和原生菜单项一致，窗口变窄也不会挤到右边的窗口按钮。

不是 Windows 桌面版、或者壳没有画出这条菜单时，同一对按钮回落到**会话标题栏最右侧**（macOS / 纯浏览器里就是这个）。两条入口共用同一套逻辑，同时在屏幕上时顶栏那份优先，标题栏那份自动让位。

没有任何弹窗，也没有控制台窗口一闪而过——重启全程屏幕上只有应用自己关掉再打开。


---

## 安装

到 [Releases](https://github.com/Ray1270/dsh-restart/releases) 下载最新的 `ray1270-dsh-restart-<版本>.tgz`，然后在应用里 **插件 → 添加插件** 填它的绝对路径。

从源码装（开发）：

```bash
dsh plugin --profile desktop add "<这个目录的绝对路径>"

# 或直接改 profile 的 package.json：
#   dependencies["@ray1270/dsh-restart"] = "link:<这个目录的绝对路径>"
#   dsh.profile.bundles 里加一行 "@ray1270/dsh-restart"
```

装完**需要重启一次应用**才会加载（这一次只能手动重启 —— 鸡生蛋）。之后就靠这两个按钮了。

---

## 它到底怎么做的

### 刷新：纯客户端，Host 不参与

```
 [浏览器] 点「刷新」
    │  1. 把当前 sessionId 写进 localStorage（同源，重载不丢）
    │  2. location.reload()
    ▼
 [页面] 重新加载：client 插件重新拉取、重新挂载
    │  3. 读到标记 → uiWorkspace.openSession(sessionId) → 删标记
    ▼
 [浏览器] 停在同一个会话
```

刷新不跨 origin，所以标记放浏览器存储就够了，不必走 Host 文件——**刷新这条链路上没有任何一次网络请求**（harness 里用「fetch 调用次数 = 0」盯着这一点）。

### 重启：Host 侧排程，helper 由 WMI 服务启动

```
 [浏览器] 点第二下
    │  POST /api/dsh-restart/restart { sessionId, force }
    ▼
 [Host] 1. 活动工作检查（force 才放行）
        2. 写 pending-restore.json（重启后要回的会话）
        3. 起一个短命的 powershell，让它调用
           Win32_Process.Create → 由 WmiPrvSE.exe 创建 helper.ps1
           （创建时带 SW_HIDE 启动信息：helper 生来没有窗口）
        4. 等 helper 写出 boot 状态 → 才回 200
    │
    ▼  helper 的父进程是 WmiPrvSE，不在应用的进程树里
 [helper] 5. 复核 ShellPid 的镜像路径仍等于目标 exe（防 PID 复用）
         6. taskkill /F 只杀 Electron 壳（**不加 /T**）
         7. 等 Host 自己退出（最多 8 秒，超时才补刀）
         8. Start-Process 重新拉起 exe（失败重试一次，并校验新进程还活着）
         9. 结果写 restart-state.json
    │
    ▼ 壳一死 → Host 的 IPC 管道断开 → process.once("disconnect")
 [Host]   application.shutdown.shutdown(0) —— 它自己的优雅退出，5 秒上限
```

**关键点 1：只杀壳，不杀树。** Host 子进程注册了 `process.once("disconnect", () => stop())`，壳一死它就自己走完整的 dispose 流程。所以「硬杀」只硬在壳这一下，Host 侧仍然是优雅收尾。

**关键点 2：helper 必须活着跨过「壳死掉」那一刻——普通子进程做不到。** 这一点最初是错的，实际表现就是「只有关、没有开」：helper 写下 `boot`、写下 `killing`、taskkill 发出去了，然后它自己跟着壳一起消失，重拉那一步根本没执行。应用关掉，再也没回来。

原因：**这个应用的子进程树不活过壳**（壳被杀 → 整棵树一起收走）。所以 helper 不能是 Host 的子进程，也不能是壳的孙进程——它必须由**进程树之外**的进程创建。`Win32_Process.Create` 由 `WmiPrvSE.exe` 执行，helper 的父进程是 WMI 服务，壳死的时候它毫发无损。`helper.log` 的 boot 行会记下 `parent=…(WmiPrvSE)`，这是这条链路生效的直接证据。

**关键点 3：不用 `detached: true`，也不靠它。** 在 Windows 上，Node 用 `detached` 启动 `powershell.exe` 会让它立刻以 0 退出——一行都不执行（实测）。而且 `detached` 本来也不提供进程树隔离（那需要 `CREATE_BREAKAWAY_FROM_JOB`，而这里的 job 不允许）。真正让 helper 活下来的是「由谁创建」，不是「怎么 detached」。

**关键点 4：WMI 启动失败就放弃重启，不赌。** 短命的 launcher 把结果写进 `launch-result.json`；Host 等不到 helper 的 `boot`、或 WMI 明确拒绝，就直接回 500 并写 `cancel-restart` 标记——还在延迟中的 helper 看到标记会立刻放弃，不会在界面已经说「没重启」之后再把应用关掉。

**关键点 5：创建的进程要「生来就是隐藏的」，不然屏幕上会多一个 PowerShell 窗口。** WMI 的 `Win32_Process.Create` 不带启动信息，控制台程序（helper 是 `powershell.exe`）便会**在创建的那一刻拿到一个可见的控制台窗口**——实测它会一直留在屏幕上，直到 helper 自己退出。`-WindowStyle Hidden` 救不了：那个开关是在窗口已经存在之后才去隐藏，实测无效。所以 launcher 构造 `Win32_ProcessStartup`（`ShowWindow = 0`，即 SW_HIDE）一起交给 `Create`，进程**一开始就不可见**。

---

## 为什么不用 `ctx.appExit`（生态里现成的「安全重启」）

`ctx.appExit(0)` 在桌面版等于让 Host 自杀。Host 一退，壳的 `child.once('close')` 就判定为**异常终止**，弹出「应用意外停止」恢复框，要用户再点一次「重启」。

那条路能用，但：多一次点击、日志里留一次假崩溃、语义上是「应用崩了」。这个插件选的是「杀壳 + 重新拉起」，所以能一次点完。`appExit` 那条路留作兜底（见下面的自救）。

---

## 配置

写在 profile 的加载行 `config:` 里（也可以直接改 `cordis.patch.yml`）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 重启总开关；`false` 时重启会报「不可用」并拒绝一切重启请求（刷新不受影响） |
| `delayMs` | `1200` | 动手前的等待，用来保证 HTTP 回执先到浏览器 |
| `hostGraceMs` | `8000` | 等 Host 自己优雅退出的上限，超时才强杀 |
| `killTimeoutMs` | `15000` | 等旧进程彻底消失的硬上限 |
| `pendingTtlMinutes` | `30` | 「重启后回哪个会话」标记的有效期 |

刷新没有配置项：它不碰 Host，也就没有可配置的危险动作。

---

## 出问题了怎么自救

按可能性排序：

1. **点了没反应、应用还在。** helper 没起来（WMI 被禁用/拦、脚本被删）。此时**应用完全没受影响**——这是刻意的：Host 等到 helper 的 `boot` 状态才回 200，等不到就直接返回 500 并放弃重启。按钮会在 12 秒后变成红色提示。先看 `~/.dsh/dsh-restart/launch-result.json`（WMI 那一步的返回码和错误），再看 `helper.log`。
2. **应用退出了但没回来。** 说明 helper 在杀之前就死了（旧版本的症状），或者 `Start-Process` 被拦。手动双击 `D:\dsh\DeepSeek Harness.exe` 即可；`restart-state.json` 里会写着停在哪一步，`helper.log` 的 boot 行会写出 helper 的父进程是不是 `WmiPrvSE`。
3. **点「刷新」后回到了首页。** 说明会话标记没能写下（无痕模式、存储被策略关闭）或会话已被删。刷新链路失败一律静默退回首页，不会卡住。
4. **想彻底绕过这一切。** 托盘右键退出，再双击图标——和以前一样。

状态文件都在 `~/.dsh/dsh-restart/`：

| 文件 | 内容 |
| --- | --- |
| `restart-state.json` | 最近一次重启的阶段（`boot` → `killing` → `killed` → `relaunching` → `relaunched` / `failed` / `aborted`） |
| `helper.log` | 逐行带时间戳的过程日志，boot 行带 helper 的父进程 |
| `launch-result.json` | WMI 创建 helper 那一步的结果：`ok` / `pid` / `returnValue` / `windowHidden` / `error` |
| `pending-restore.json` | 待恢复的会话标记，被下一次页面加载消费后即删除 |
| `cancel-restart` | 只在 Host 放弃一次启动时短暂出现：还在延迟中的 helper 看到它就退出，不再动手 |

---

## 已知限制

- **刷新不重载 Host 侧插件。** 它只是把浏览器这一半重新装一遍：客户端插件、原生菜单、样式都会更新；Host 插件（路由、服务）必须用「重启」。
- **刷新会丢没发出去的草稿。** 输入框内容只活在页面里。已发送的对话、正在生成的回复、后台 job 都不受影响。
- **顶栏入口依赖桌面壳的菜单条。** 那条菜单是 `preload` 用 `data-windows-menu` 标记 + open shadow root 画的，不是 Web 客户端的 slot。插件按「探测不到就退让」处理：找不到宿主就静默不挂载，标题栏入口顶上；壳若在未来版本改了结构，最多是回到标题栏，不会报错也不会留半个按钮。
- **同一时刻只有一个入口在屏幕上。** 顶栏挂载成功时标题栏那对会渲染成空（但仍然挂着，因为它是唯一拿得到 `sessionId` 的地方，用来做刷新/重启后的会话回填）。
- **重启只支持桌面版。** CLI / headless 的 Host 没有壳可重启；检测到这种情况时按钮会明确报「不支持」。刷新在任何环境都可用。
- **重启会中断进行中的工作。** 确认框里的数字就是会断掉的东西，确认过就是真断。会话记录是追加写，丢的是进行中那一轮和 job 输出。
- **重启后端口会变。** 旧标签页一律失联，壳会开新页面；远程访问的地址也会变。刷新不会。
- **重启依赖 WMI 服务。** helper 必须由 `WmiPrvSE.exe` 创建，否则它活不过壳被杀的那一刻。WMI 被策略关掉、或 `Win32_Process.Create` 被安全软件拦住时，重启会**明确拒绝**（应用不受影响），错误和返回码写在 `launch-result.json`。这是有意的取舍：宁愿不重启，也不要关掉一个回不来的应用。
- **杀软可能好奇。** 「隐藏窗口的 PowerShell 杀掉应用再拉起」是 EDR 的经典启发式，加上 WMI 创建进程就更容易被盯。所以 helper 是明文的、带完整注释的、固定路径、日志可查，没有做任何编码混淆；`launch-result.json` 连 WMI 的原始返回码都留着。
- **极端情况下仍可能看到一个控制台窗口。** 如果某台机器上 `Win32_ProcessStartup` 构造失败，helper 就会退回「可见窗口」启动（重启本身照常工作）：`launch-result.json` 里 `windowHidden` 会是 `false`，Host 日志也会留一行 warn。属于「看得见、可查」，不是静默发生。

---

## 开发与测试

没有任何构建步骤：`lib/index.js`（Host 半区）、`lib/client.js`（浏览器半区）、`lib/helper.ps1`（重启动作）都是可以直接读的源码。

```bash
node scripts/smoke-host.mjs      # Host 半区 37 项：路由、状态、活动工作计数、标记消费、命令行/WMI 脚本拼装（含隐藏窗口）
node scripts/smoke-client.mjs    # 浏览器半区 27 项：装载、slot 注册、两条入口、会话续接、刷新标记
node scripts/selftest-helper.mjs # helper 真机自检 23 项：直启与 WMI 启动各跑一遍杀进程/等退出/重新拉起、取消标记、PID 复用防护，并扫屏确认没有控制台窗口
```

`selftest-helper.mjs` 用一次性的 `powershell.exe` 进程冒充「壳」和「Host」，**不会碰真正的 DSH**，因为它自己正跑在里面。第 2 组用的是和 Host 完全相同的 WMI 启动路径，并断言 helper 的父进程是 `WmiPrvSE.exe`——也就是说，「helper 不随壳一起死」这一点是跑出来验证的，不是推断的。同一组还会在 helper 运行期间**真的枚举屏幕上的可见窗口**（`scripts/find-visible-window.ps1`），确认没有那个标题为 `dsh-restart helper` 的控制台窗口；扫描器本身先对着一个已知可见的窗口验证过「看得见才算数」，免得负断言变成一个瞎子的断言。

手工打开的浏览器 harness（`file://` 打开即可）：

| 文件 | 断言 | 覆盖 |
| --- | --- | --- |
| `scripts/caption-harness.html` | 23 | 挂载时机、按钮顺序、字号/高度继承、两击重启契约、`sessionId` 进入 POST body |
| `scripts/refresh-harness.html` | 10 | **真重载**：点刷新 → 页面真的重载 → 标记存活 → 回到同一会话 → 标记被消费 |

`refresh-harness.html` 分两阶段跑（结果和「已点击」状态放 sessionStorage，跨重载存活），因为要测的行为本身就是「页面会消失」。

浏览器半区的 slot 位置来自 DSH 自带的 slot 目录（`dsh-cordis-client-runner` 里的 `conversation.session.header.utilities`：右对齐、可叠加、注入 `sessionId`）。顶栏那条菜单条则来自 `app.asar` 的 `lib/preload-app.cjs`（`installWindowsMenu`）。

---

## 卸载

```bash
dsh plugin --profile desktop remove @ray1270/dsh-restart
```

或者从 profile 的 `dsh.profile.bundles` 里删掉那一行，再重启。

残留物只有 `~/.dsh/dsh-restart/` 这个目录，删掉即可。
