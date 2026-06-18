# ccusage-lite 设计文档（当前实现）

初版 2026-06-17，随实现更新。本文件以 `bin/ccu.js` 现有函数名为准。

## 背景与问题
前端开发者同时维护多个项目，用 nvm 在 node14/16/18 间切换。全局 statusLine 配置 `ccusage statusline`，但 ccusage 需要 node20+；当激活的是 node14/16/18 时，statusline 进程崩溃，状态栏失效。需要一个在任意 node 版本下都能运行的 ccusage 替代品。

## 目标
- 在 node14 → 最新版任意 node 下零崩溃运行。
- 统计 Claude Code 本地用量（token 为主，花费为参考）。
- 提供 statusline。
- 命令集：`week`(默认) / `month` / `today` / `session` / `total` / `statusline` / `help`。

## 非目标
- 不做 live 实时监控、不做 5 小时 block 配额、不做 JSON 导出（YAGNI）。
- 不联网拉取定价，不追求与代理实际结算精确一致。

## 架构（单文件 `bin/ccu.js`，分层函数）

1. **数据发现层**：`listJsonlFiles(dir)` 递归列出 `~/.claude/projects` 下所有 `.jsonl`；`filesSince(ms)` 用 mtime 过滤（"今日"/区间命令只解析近期文件）。
2. **解析层**：`parseFile(file, onRecord)` 用 `readline` 逐行流式读取，每行 `JSON.parse`，失败跳过；`extractRecord(obj)` 提取 `{id, requestId, model, sessionId, cwd, ts, input/output/cacheWrite/cacheRead}`，非用量行返回 null。
3. **聚合层**：`buildAgg(files, opts)` 流式喂入 `addRecord`，按 `id|requestId` 去重，累计四维 token；按模型、按天（含天×模型二维）、按会话分组。`opts.day` 精确单日过滤，`opts.sinceDay` 区间（>=）过滤。
4. **计价层**：`priceFor(model)`（精确 key → 最长前缀 → 系列子串 fallback，见 `lib/pricing.json`）+ `costOf(rec)` 返回参考美元。
5. **展示层**：`printTable`/`printDayTable`/`printSessionTable` 渲染中文带边框表格（`dispWidth` 按 CJK 算 2 列对齐，`fmtInt`/`fmtMoney` 千分位）；`renderStatusline(model, ctx, session, today, ctxWindow)` 渲染单行；`contextWindowFor(modelId)` 取占比分母。
6. **入口**：`main(argv)` 分发子命令；`statusline` 从 stdin 读 Claude Code 注入的 JSON（`model.display_name`/`model.id`/`transcript_path`）。

## 数据流
- 表格命令（today/week/month/total/session）：发现文件 → mtime 过滤 → 解析 → 去重聚合（按 day/sinceDay 过滤）→ 表格渲染 → stdout。
  - `week`/`month`：`filesSince(startMsOffset(n-1))` + `buildAgg({sinceDay})`，按天分组表。
  - `today`：当天零点 mtime + `buildAgg({day})`。
  - `session`：当天零点 mtime + `buildAgg({day})`（**必须按今日过滤**，否则旧日期记录会混入今日会话），按会话分组表。
  - `total`：全量扫描，无日期过滤。
- statusline：读 stdin JSON → 取 `transcript_path` 解析当前会话花费与上下文占用；取 mtime=今日的文件 + `{day}` 解析今日总量 → 按 `model.id` 查上下文窗口 → 渲染单行 → stdout。全程 try/catch，异常输出降级行。

## 关键设计决策
- **今日靠 mtime 过滤而非缓存**：今日记录只存在于今天被追加过的文件，过滤 mtime 即可只解析少数文件，省掉缓存复杂度（YAGNI）。`total` 才全量扫描，且非高频。
- **去重键 `id|requestId`**：与 ccusage 同源问题，resume/retry 会重复写同一 assistant 记录。
- **价格最长前缀匹配**：transcript 里的 model 常带 provider 前缀和日期后缀；`longestPrefixMatch` 先经 `modelCandidates` 剥离 `anthropic/`、`openrouter/` 等前缀，再取最长前缀 key（如 `anthropic/claude-opus-4-1-20250805` → `claude-opus-4-1`），避免旧 Opus 4/4.1（$15/$75）被误退到通用 opus fallback（$5/$25）而低估。`priceFor` 与 `contextWindowFor` 共用此逻辑。
- **上下文窗口按模型 id 配置**：`contextWindows` 列出 1M 模型，未命中回落 `contextWindow`(200000)。1M 范围以官方 long context 列表维护（当前 = Fable 5 / Opus 4.6-4.8 / Sonnet 4.6），不写死过宽范围；占比仅为估算口径。
- **花费=参考**：代理结算不可知，金额仅基于官方定价表（静态、需定期核对）估算并显式标注，再乘 `multiplier`。

## statusline 输出
```
🤖 <模型显示名> │ 上下文 <tok> (<%>) │ 当前会话 $<参考> (参考) │ 今日 $<参考> (参考)
```
异常降级：输出 `🤖 Claude` 一行，绝不抛错使状态栏失效。

## 错误处理
- 单行 JSON 解析失败 → 跳过该行；文件读取失败 → 跳过该文件。
- statusline 顶层 try/catch → 降级行；stdin 无/非法 JSON → 模型名降级、仅渲染可得部分。

## 测试（`test/run.js`，零依赖、当前 node 跑）
覆盖：extractRecord 提取、去重、四维累计、计价（精确/最长前缀/带后缀/provider 前缀回退）、contextWindowFor 命中与回落、localDay、statusline 格式、fmt* 格式化、dayKeyOffset、sinceDay 区间过滤、跨日 session 只计今天、node14 禁用语法源码扫描。
- 语法兼容另用 `node --check bin/ccu.js`。
- 真实跑通：`node bin/ccu.js today` / `session` / `statusline`。

## 安装与落地
见 `INSTALL.md`（按 Windows/macOS 分步，把命令 shim/软链指向 `bin/ccu.js`，可选接入 Claude Code `settings.json` 的 statusLine）。本机部署细节不写死在本文档，避免被当成通用规范。
