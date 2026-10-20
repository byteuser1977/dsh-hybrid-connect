# dsh-hybrid-connect

> **一句话**：一个 DSH 插件，把 **Trae 远程模型**（国内版/国际版）与 **本地 OpenAI 兼容端点**（Ollama / llama.cpp / LM Studio / vLLM）接在同一个 Loopback 入口，按 `model id` 自动分流。

- ✅ **零配置上手**：装上即用，自动发现已安装 Trae、复用登录态、拉取模型目录
- ✅ **双版本并行**：`trae`（国内版）+ `trae-intl`（国际版）两组 Provider 无条件注册，凭据缺失自动隐藏
- ✅ **混合路由**：`by-prefix`（仅 `local@` 前缀走本地，默认零误判） / `by-id`（命中本地目录走本地，失败回退 Trae）
- ✅ **完整移植**：`install.js` / `upstream.js` / `credentials.js` **逐字节复制**自 `dsh-trae-connect`，协议翻译、凭据解密、令牌续期、安装发现、SSE 去重、即用即焚、1M 上下文、思考强度、锁定标注……全部保留
- ✅ **自足独立**：无外部依赖 `dsh-trae-connect`，单插件即可跑通

---

## 1. 架构

```
                DSH 宿主 (PiAiAdapter)
                       │  model = "local@qwen2.5:14b" / "deepseek-v4.1-flash"
                       ▼
        ┌──────────────────────────────────────────┐
        │  createHybridShim  (127.0.0.1, 随机端口)   │
        │  Host/Origin 回环校验 + per-edition Bearer │
        │  ┌────────────────────────────────────┐  │
        │  │ L1  decideRoute(model, edition)    │  │  router.js（零 I/O）
        │  │     kind:"trae" │ kind:"local"     │  │
        │  └───────┬───────────────┬────────────┘  │
        └──────────┼───────────────┼───────────────┘
                   ▼               ▼
        L2a Trae 分支            L2b 本地分支（local.js，纯转发）
        upstream.js 的 SSE 翻译    fetch → /v1/chat/completions
        credentials.js 解密/续期   无凭据、无协议翻译
        install.js 安装发现
```

| 层 | 职责 | 文件 | 状态 |
|---|---|---|---|
| L0 | DSH 选模型 → `${shim.baseUrl()}/v1` | `index.js` (`PiAiAdapter`) | ✅ 完整 |
| L1 | 按 model id 分流 | `router.js` | ✅ 完整（2 种策略，零误判默认） |
| L2a | Trae 远程协议翻译 | `upstream.js`（**完整移植**） | ✅ 完整 |
| L2b | 本地端点纯转发 | `local.js` | ✅ 完整（SSE 透传 + 错误处理） |
| — | 凭据解密/续期 | `credentials.js`（**完整移植**） | ✅ 完整 |
| — | 安装位置发现 | `install.js`（**完整移植**） | ✅ 完整 |

---

## 2. 文件清单

| 文件 | 行数 | 说明 |
|---|---|---|
| `install.js` | 311 | 逐字节移植自 `dsh-trae-connect`；注册表扫描 + product.json 判版本/镜像 |
| `upstream.js` | 786 | 逐字节移植自 `dsh-trae-connect`；Trae remote SSE 协议客户端 |
| `credentials.js` | 717 | 逐字节移植自 `dsh-trae-connect`；tc 信封解密 + ExchangeToken 续期 |
| `router.js` | ~100 | 新增；`by-prefix` / `by-id` 双策略路由决策，目录缓存 + 失败回退 |
| `local.js` | ~100 | 新增；本地端点 SSE 透传 / JSON 转发，纯转发无副作用 |
| `index.js` | ~730 | 重写；接线 + 路由插入点 + 2 个 P 项 bug 修复，移植版 `apply()` 骨架 |
| `package.json` | — | **不再依赖 `dsh-trae-connect`** |
| `README.md` | — | 本文件 |

**移植保真度**：`install.js` / `upstream.js` / `credentials.js` 三个文件**逐字节复制**自 `dsh-trae-connect`（未做任何修改，历史注释和踩坑记录完整保留）；仅在 `index.js` 里做接线。

---

## 3. 路由策略（`router.js`）

| 策略 | 行为 | 失败模式 |
|---|---|---|
| `by-prefix`（默认） | 仅 `local@` 前缀走本地；其余一律走 Trae | **不可能误判**（不依赖本地服务器目录） |
| `by-id` | 模型 id 命中本地 `/v1/models` 目录 → 本地；未命中 → Trae | 目录拉取失败（本地服务器离线）**回退 Trae**，不拒绝请求；`auto` 永远走 Trae |

- 本地未配置（`localBase` 留空）→ 本插件与纯 Trae 行为**完全一致**，零额外开销。
- 目录缓存 60s TTL，稳态零网络请求；拉取失败按 30s 负缓存冷却（本地服务器离线不会拖慢后续请求），并发请求合并为一次探测，配置卡修改 `localBase` 立即作废旧缓存。

---

## 4. 移植过程中落实的修复

| 原分析问题 | 本插件状态 | 说明 |
|---|---|---|
| **P4**：客户端断开不取消上游 | ✅ **已修** | `index.js` `chatCompletions` 用 `res.on("close")`（响应流真正关闭时触发）而非原版的 `req.on("close")`（可能在请求体刚读完就过早触发） |
| **P2**：CN 状态卡误用 intl 积分地址 | ✅ **已修** | `createEditionStatus` 现在按 edition 传 `creditsBase`：CN 传 `undefined`（走 `fetchCredits` 自己的 CN 默认分支），仅 intl 传配置值 |
| **P5**：静态 Bearer 密钥 | ✅ **已修** | `EDITION_SECRETS` 改为模块加载时每个版本 `randomBytes(32)` 随机生成；`resolveApiKey` 去掉 `SHARED_SECRET` 兜底 |
| **P14**：`readBody` 无上限 | ✅ **已修** | 16 MiB 上限，先查 `Content-Length` 再按流累计；超限返回 413 `payload_too_large`（非 400） |
| **P10**：SSE `plan_item` 非前缀快照整段重发 | ✅ **已修** | else 分支不再重发，仅同步存储供后续增量帧使用，不产生重复文本 |
| **P1/P8/P9/P11** | ⚠️ **沿用移植版原样** | 源于 `dsh-trae-connect` 上游代码本身，"完整移植"刻意不动；需要修复时另开任务 |

---

## 5. 配置卡字段（`.volatile()`）

沿用 `dsh-trae-connect` 全部字段（`useMaximumContextWindow` / `autoDeleteSession` / `dataDirCn` / `dataDirIntl` / `intlRemoteBase` / `intlWebOrigin` / `intlCreditsBase`），新增：

| 字段 | 默认 | 说明 |
|---|---|---|
| `localBase` | `""` | 本地端点根地址（如 `http://127.0.0.1:11434/v1`）。留空 = 关闭本地路由。 |
| `localKey` | `""` | 本地 Bearer Key（Ollama 通常留空）。 |
| `hybridPolicy` | `by-prefix` | `by-prefix` \| `by-id`。 |

---

## 6. 注册的 Provider

沿用 `dsh-trae-connect` 的两个（无凭据时目录为空、分组隐藏）：

- `trae`（Trae 国内版）
- `trae-intl`（Trae 国际版）

`cordis.patch.yml` 只插 `llm-hybrid`，但 `apply()` 内部**同时注册** `trae` / `trae-intl` 两个 provider（与原版行为一致）。

---

## 7. 后续工作（未在本次移植范围）

1. ~~body 大小上限（P14）~~ ✅ 已落地
2. ~~静态 Bearer → `randomBytes(32)`（P5）~~ ✅ 已落地
3. ~~SSE 去重逻辑修复（P10，`upstream.js` 的 `plan_item` 分支）~~ ✅ 已落地
4. 级联回退（形态 C：Trae 502/超时 → 自动重发本地）
5. `node:test` 单测（`router` / `local` / `upstream.parseModelList` / `credentials.decryptStorageValue` 均为窄接口/纯函数）

---

## 许可证

MIT（与 `dsh-trae-connect` 一致）。
