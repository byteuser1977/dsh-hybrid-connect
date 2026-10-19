# dsh-hybrid-connect

**混合模型路由插件（DSH）**：同一个 Loopback OpenAI 端点，按请求分流到 **Trae 远程**（复用 `dsh-trae-connect` 的协议翻译与凭据）或**本地 OpenAI 兼容模型**（Ollama / llama.cpp / LM Studio / vLLM）。

**本项目已完整移植 `dsh-trae-connect` 全部功能代码**（`credentials.js` / `upstream.js` / `install.js` / `index.js`），并加入路由层（`router.js` / `local.js`）——不再依赖外部 `dsh-trae-connect`，是**自足的独立插件**。

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
- 目录缓存 60s TTL，稳态零网络请求。

---

## 4. 移植过程中落实的修复

| 原分析问题 | 本插件状态 | 说明 |
|---|---|---|
| **P4**：客户端断开不取消上游 | ✅ **已修** | `index.js` `chatCompletions` 用 `res.on("close")`（响应流真正关闭时触发）而非原版的 `req.on("close")`（可能在请求体刚读完就过早触发） |
| **P2**：CN 状态卡误用 intl 积分地址 | ✅ **已修** | `createEditionStatus` 现在按 edition 传 `creditsBase`：CN 传 `undefined`（走 `fetchCredits` 自己的 CN 默认分支），仅 intl 传配置值 |
| **P1/P5/P8/P9/P10/P11/P14** | ⚠️ **沿用移植版原样** | 这些问题源于 `dsh-trae-connect` 的上游代码本身（`upstream.js`/`credentials.js` 的 SSE 去重、静态 Bearer、`readBody` 无上限等），本次"完整移植"刻意不动；需要修复时另开任务 |

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

1. body 大小上限（P14）
2. 静态 Bearer → `randomBytes(32)`（P5）
3. SSE 去重逻辑修复（P10，`upstream.js` 的 `plan_item` 分支）
4. 级联回退（形态 C：Trae 502/超时 → 自动重发本地）
5. `node:test` 单测（`router` / `local` / `upstream.parseModelList` / `credentials.decryptStorageValue` 均为窄接口/纯函数）

---

## 许可证

MIT（与 `dsh-trae-connect` 一致）。
