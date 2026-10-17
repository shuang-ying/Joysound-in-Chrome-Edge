# Joysound 视频音效增强（Chrome / Edge 扩展）

把 [qianjiachun/joysound-tampermonkey](https://github.com/qianjiachun/joysound-tampermonkey)
这个油猴脚本移植成了标准的 Chrome / Edge 扩展（Manifest V3），并修掉了它最影响体验的问题：

> **每次切出浏览器标签页再切回来，音频效果就消失了。**

扩展在「切回来」这件事上做了一整套自愈，同时也保证**任何情况下都不会把页面声音弄哑**。

---

## 安装

**注意：仓库里不附带第三方音效引擎**，需要先在本地生成一次（和原版油猴脚本「运行时从官方 CDN 取」同一个思路，只是把这一步挪到了安装时）。

```bash
git clone https://github.com/shuang-ying/Joysound-in-Chrome-Edge.git
cd Joysound-in-Chrome-Edge
node tools/extract-joysound.js      # 需要 Node 18+ 与网络，生成 vendor/joysound.sdk.js
```

看到 `已写入 vendor/joysound.sdk.js（98113 字节），版本 1.0.1` 即成功。然后：

1. 打开浏览器扩展管理页：
   - Chrome：`chrome://extensions`
   - Edge：`edge://extensions`
2. 打开右上角「开发者模式」。
3. 点「加载已解压的扩展程序」，选择本目录。
4. 建议把 Joysound 图标固定到工具栏。

> 如果忘了生成引擎，扩展不会静默失效：弹窗会直接显示「缺少音效引擎」并提示要执行的命令，页面声音不受影响。
>
> Chrome 137 之后，命令行开关 `--load-extension` 已被品牌版禁用（自动化脚本会失败），
> 但**手动「加载已解压的扩展程序」仍然可用**。仓库里的自动化测试会自动改用 Edge 完成。

## 使用

1. 打开任意有视频的网页（AcFun / Bilibili / YouTube / 各类播放器都行）。
2. 点工具栏上的 Joysound 图标 → 打开「**在此网站启用**」。
3. **立即生效，不需要刷新页面**（这点比油猴版更好，油猴版要求页面里已经有 video 元素）。
4. 弹窗底部会实时显示状态：

| 状态 | 含义 |
| --- | --- |
| 已生效 | 音效链已经接管并通过了工作线程回执 |
| 正在接管音频… | 正在创建 AudioContext / 加载 AudioWorklet |
| 页面暂无视频 | 还没有找到 `<video>`，开始播放会自动接管 |
| 被站点 CSP 限制 | 站点安全策略禁止 AudioWorklet/Worker，扩展主动放弃，不会影响原声 |
| 音频已被页面占用 | 站点自己在扩展之前就捕获了音频，点弹窗里的「刷新页面」即可 |
| 媒体受跨域保护，已跳过 | 视频是跨域且没走 CORS，接管后必静音，扩展干脆不动它 |
| 拿不到音频数据 | 已接管但取不到声音（DRM 等），扩展已切回原始直通 |
| 音效线程未响应 | AudioWorklet 没回执，扩展已切回原始直通 |

「总开关」关掉后所有站点都不再接管音频。

---

## 这次修了什么：切标签页音效消失

### 原脚本为什么失效

原脚本的逻辑是「找到 `<video>` → `new Joysound()` → `init(node)` → `setEnabled(1)`，只做一次」。
而真实播放器在「切出 → 切回」时经常会做下面这些事，任意一件都会让那一次性的绑定失效：

| 站点行为 | 后果 |
| --- | --- |
| 重建 `<video>` 节点（换 `<video>`、重新挂载 DOM） | 旧的 `MediaElementAudioSourceNode` 绑在**旧节点**上，新节点是裸声 → 音效消失 |
| 重新初始化播放器（重新 `new AudioContext()`） | 站点自己捕获音频，与原脚本的捕获冲突 |
| 浏览器挂起 `AudioContext`（后台标签页 / 系统音频焦点切换） | 上下文停在 `suspended`，声音绕过滤波或直接变哑 |
| 页面被冻结 / bfcache 恢复 | 定时器停摆，恢复后没人重新检查 |
| 站点在扩展之前就捕获了音频 | `createMediaElementSource` 抛 `InvalidStateError`，打断站点自己的初始化 |

### 现在的做法

不是「一次性 init」，而是一个**带健康检查的会话管理器**（`src/content/engine.js`）：

- **节点巡检**：`MutationObserver` + 1.5s 定时巡检 + 媒体事件（`play`/`loadedmetadata`/`emptied`/`canplay`），
  一旦发现节点被替换、被移除、或出现新的 `<video>`，立刻重新接管。
- **切回来的多段恢复**：`visibilitychange` / `pageshow` / `focus` / Page Lifecycle 的 `resume` 事件
  触发后，会在 120ms / 600ms / 1600ms / 3200ms **反复重扫并校验**——
  因为播放器重建 DOM 往往比 `visibilitychange` 晚一点。
- **上下文保活**：`AudioContext` 被挂起就 `resume()`（不能重建，见下文 Chromium 约束）；
  页面冻结/解冻、`pageshow`、`focus` 之后都会立刻补一次。
- **工作线程回执**：`setEnabled(1)` 之后必须收到 AudioWorklet 的 `statuChange` 回执，
  收不到就重发；超时仍没有回执 → 降级为直通并说明原因（绝不销毁上下文）。
- **零采样检测**：接管后在 `running` 状态下持续对比「解码字节数在增长」和「输出峰值为 0」。
  连续命中说明根本拿不到音频（跨域媒体、DRM、工作线程异常），降级为直通并把原因写进弹窗。

### 两条「绝不弄哑 / 绝不卡播」的安全网

1. **能力预检**（`ensureProbe`）：接管任何视频之前，先用一个一次性的 `AudioContext`
   试加载一个 1 行 AudioWorklet。站点 CSP 不允许 `blob:` worklet 时直接放弃接管——
   否则「元素被捕获但链路没接上」会让页面彻底静音。
2. **跨域预检**（`isCaptureTainted`）：跨域且未声明 `crossorigin` 的媒体，
   捕获后**必定**是静音（实测 peak 恒为 0），而且没法回退。所以在接管之前就识别并跳过，
   弹窗提示「媒体受跨域保护，已跳过」。

### 关闭开关 = 直通旁路，而不是销毁上下文

这是 Chromium 的一个硬约束（用四种拆链方式逐一做过对照实验）：

- 媒体元素一旦被 `createMediaElementSource` 捕获，它的**播放时钟就由音频图驱动**；
  只要断开输出或 `AudioContext.close()`，视频会立刻**冻住**（`currentTime` 不再前进）。
- `close()` 之后元素仍然被这个「死上下文」占着（再捕获抛 `InvalidStateError`），
  Chrome **不会**把声音还给原生输出——这就是「关掉开关后没声 / 卡住、要刷新才行」的根因。

所以 1.1 起「关闭」不再销毁任何东西，而是**保活旁路**：

```
音效开： source ──→ [ Joysound 音效链 ] ──→ destination
音效关： source ───────────────────────────→ destination
```

- 上下文一直保持 `running`（后台还有 1.5s 一次的保活巡检，防止被挂起冻住播放）；
- 音效处理完全绕开，听到的就是原始音频；
- 再打开开关时，同一套链路原地接回，**不新建 AudioContext、不重新捕获元素**；
- 只有元素离开文档（换视频、SPA 路由）时才会真正关闭上下文，此时是安全的。

### 顺带修掉的一个隐患

一个 `<video>` 只能被捕获一次。扩展接管后再让站点自己调用 `createMediaElementSource`，
Chrome 会抛 `InvalidStateError`，把站点播放器的初始化打断（这也是原脚本要 `unsafeWindow.AudioContext = null`
这种「同归于尽」写法来规避的原因）。

现在改成在主世界最早期（`document_start`）给原型打一个**精准补丁**（`src/content/early.js`）：

```js
AudioContext.prototype.createMediaElementSource = function (el) {
  if (owned.has(el)) return this.createGain();   // 只对「已被扩展接管」的元素返回静音替身
  return original.call(this, el);                // 其余完全透传
};
```

站点代码拿到一个合法的节点、不再抛异常，扩展则在**捕获的同一瞬间**把元素登记为已接管，
不存在时间空窗。未启用的站点完全无副作用。

---

## 工作原理

```
┌─────────────────────────── 页面主世界 (MAIN) ───────────────────────────┐
│ early.js   document_start：捕获保护（精准补丁，无副作用）                 │
│ engine.js  按需注入：会话管理 / 自愈 / 计量 / 与 SDK 对接                 │
│ vendor/joysound.sdk.js   本地打包的音效引擎（Web Audio + AudioWorklet）    │
└───────────────────────────────▲────────────────────────────────────────┘
                                │ window.postMessage（cmd / status / hello）
┌───────────────────────────────┴────────────────────────────────────────┐
│ bridge.js  隔离世界：读 chrome.storage、算出本站是否启用、转报状态         │
└───────────────────────────────▲────────────────────────────────────────┘
                                │ chrome.runtime 消息
┌───────────────────────────────┴────────────────────────────────────────┐
│ background.js  Service Worker：按 frame 注入引擎、汇总状态、更新角标       │
└───────────────────────────────▲────────────────────────────────────────┘
                                │
                        popup/  弹窗 UI（站点开关 / 总开关 / 实时状态）
```

为什么引擎要「按需注入」而不是写进 `content_scripts`：
`chrome.scripting.executeScript({ world: "MAIN" })` 可以绕过站点 CSP，
也不会在没启用的页面上白白解析 100KB 脚本。

### 与原油猴脚本的对应关系

| 油猴 | 扩展 |
| --- | --- |
| `@resource` 下载 2.8MB 插件包 + 字符串插入 + `eval`（MV3 禁止远程代码） | `vendor/joysound.sdk.js`，用 [`tools/extract-joysound.js`](tools/extract-joysound.js) 从同一个包里抽出模块 #17（98KB） |
| `unsafeWindow` | `world: "MAIN"` 内容脚本 / `executeScript` |
| `GM_setValue` / `GM_getValue` | `chrome.storage.local` |
| `GM_registerMenuCommand` | 弹窗 UI（站点级开关 + 总开关） |
| `GM_openInTab` | 普通链接 |
| `GM_xmlhttpRequest` / `@connect` | 已移除（音效引擎的 wasm 内联在 bundle 里，不联网） |
| 只查 `document.querySelectorAll("video")` | 额外扫描开放的 **Shadow DOM**（最多 4 层） |
| 一次性 `init` | 会话管理 + 健康检查 + 自愈 |

---

## 目录结构

```
manifest.json               MV3 清单
src/
  background.js             Service Worker：注入、状态汇总、角标
  content/
    early.js                主世界 document_start：捕获保护补丁
    bridge.js               隔离世界：设置同步 / 状态转报
    engine.js               主世界：会话管理、健康检查、直通旁路
vendor/
  README.md                 说明：引擎文件为何不入库
  joysound.sdk.js           ← 本地生成（git 忽略），第三方引擎，约 98KB
popup/                      弹窗 UI
icons/                      16/32/48/128 图标
tools/extract-joysound.js   生成 vendor/joysound.sdk.js
test/
  engine.unit.js            引擎状态机单元测试（假 DOM / 假 SDK）
  e2e.js                    真实浏览器 + 真实扩展的端到端测试
  fixture/                  测试页（含 iframe）与音频素材生成
  make-fixture.js
```

## 测试

```bash
# 状态机（无需浏览器，秒级）
node test/engine.unit.js

# 端到端（会启动真实浏览器，加载真实扩展）
node test/e2e.js
node test/e2e.js --headed     # 有头模式，便于观察
```

端到端覆盖：未启用时不注入、**在已打开的页面上启用（不刷新）**、接管、真实音频信号、
站点二次捕获、切标签页往返、播放器重建、`pageshow`、`AudioContext` 被挂起、
页面冻结/解冻、视频移除、**关闭开关后不静音不卡播**、iframe、弹窗 UI、页面异常。

当前结果：**单元 36 项 / 端到端 44 项全部通过**（Edge 155 / Chromium 155 实测）。

## 已知限制

- **站点 CSP 禁止 AudioWorklet/Worker**：扩展会预检并直接放弃，页面原声不受影响。
- **跨域媒体（无 `crossorigin`）**：浏览器不允许取到音频数据，扩展在接管**之前**就跳过，
  不会动这类视频（如果你确认站点支持 CORS，可以给 `<video>` 加 `crossorigin="anonymous"`）。
- **接管过之后，扩展会一直持有该元素的音频**：这是 Chromium 的限制，关闭开关只是切回直通，
  要彻底放手只能刷新页面或让站点换一个新的 `<video>`。
- **站点先捕获了音频**：需要刷新一次页面，让扩展的补丁先到位（弹窗会给出按钮）。
- **closed shadow root** 里的 `<video>` 无法访问（规范限制）。
- **DRM 内容**：受保护媒体不会输出到 Web Audio，扩展会降级为直通并把原因写进弹窗。
- 每个页面最多同时接管 3 个 `<video>`（避免 AudioContext 数量超限）。

## 许可与致谢

- 原脚本作者：[qianjiachun](https://github.com/qianjiachun/joysound-tampermonkey)（MIT，`Copyright (c) 2022 小淳`）。
  本项目是其**修改版/移植版**，并非原作者发布，详见 [NOTICE](NOTICE)。
- **Joysound 音效引擎**：来自 AcFun 播放器（版权归快手 / AcFun 所有），
  本项目**不再分发**该文件，只保留提取脚本，由使用者在本机生成 `vendor/joysound.sdk.js`。
- 本移植版代码：MIT（见 [LICENSE](LICENSE)）。

> 如果你要 fork 后二次发布，请同样不要把他人生成的 `vendor/joysound.sdk.js` 提交到公共仓库。
