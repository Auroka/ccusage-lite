# ccusage-lite 设计文档

日期：2026-06-17

## 背景与问题
前端开发者同时维护多个项目，用 nvm 在 node14/16/18 间切换。全局 statusLine 配置 `ccusage statusline`，但 ccusage 需要 node20+；当激活的是 node14/16/18 时，statusline 进程崩溃，状态栏失效。需要一个在任意 node 版本下都能运行的 ccusage 替代品。

## 目标
- 在 node14 → 最新版任意 node 下零崩溃运行。
- 统计 Claude Code 本地用量（token 为主，花费为参考）。
- 提供 statusline。
- 够用就好的命令集：today / session / total / statusline。

## 非目标
- 不做 live 实时监控、不做 5 小时 block 配额、不做 JSON 导出（够用就好范围之外，YAGNI）。
- 不联网拉取定价，不追求与代理实际结算精确一致。

## 架构（单文件，分层函数）
`bin/ccu.js` 内部分层：

1. **数据发现层**：`listJsonlFiles(dir)` 递归列出 `~/.claude/projects` 下所有 `.jsonl`；`filterByMtimeSince(files, ms)` 用于"今日"快速过滤。
2. **解析层**：`parseFile(file, onRecord)` 用 `readline` 逐行流式读取，每行 `JSON.parse`，失败跳过。提取 `{id, requestId, model, ts, usage}`。
3. **聚合层**：`aggregate(records)` 全局按 `id|requestId` 去重，累计四维 token，按模型/按天分组。
4. **计价层**：`costOf(usage, model)` 查 `lib/pricing.json`（精确 key → 子串 opus/sonnet/haiku 回退），返回参考美元。
5. **展示层**：`renderToday/renderSession/renderTotal/renderStatusline`，格式化 token（K/M）与金额（带"参考"）。
6. **入口**：`main(argv)` 分发子命令；`statusline` 从 stdin 读 Claude Code 注入的 JSON。

## 数据流
- CLI（today/session/total）：发现文件 → 过滤 → 解析 → 聚合 → 展示 → stdout。
- statusline：读 stdin JSON → 取 `transcript_path` 解析当前会话；取 mtime=今日的文件解析今日总量 → 渲染单行 → stdout。全程 try/catch，异常输出降级行。

## 关键设计决策
- **今日靠 mtime 过滤而非缓存**：今日记录只存在于今天被追加过的文件，过滤 mtime 即可只解析少数文件，省掉缓存复杂度（YAGNI）。`total` 才全量扫描，且非高频。
- **去重键 `id|requestId`**：与 ccusage 同源问题，resume/retry 会重复写同一 assistant 记录。
- **花费=参考**：代理结算不可知，金额仅基于官方定价表估算并显式标注。

## statusline 输出
```
🤖 <模型显示名> │ 会话 <tok>（$<参考>） │ 今日 <tok>（$<参考>）
```
异常降级：输出空字符串或仅模型名，绝不抛错使状态栏失效。

## 错误处理
- 单行 JSON 解析失败 → 跳过该行。
- 文件读取失败 → 跳过该文件。
- statusline 顶层 try/catch → 降级行。
- stdin 无/非法 JSON → 仅渲染"今日"部分。

## 测试
- `test/run.js`（零依赖、当前 node 跑）：
  1. 去重：同 id|requestId 多行只计一次。
  2. 四维 token 累计正确。
  3. 坏行跳过不影响其余。
  4. statusline 给定 stdin JSON 输出格式正确且不抛错。
  5. 计价回退：未知模型名按子串匹配。
- 语法兼容校验：用 `node --check` + 简单扫描禁用 API。
- 真实跑通：`node bin/ccu.js today` / `total` / `statusline`。

## 落地
- shim `ccu.cmd` 复制到 `C:\Users\Administrator\bin`（已在 PATH，且与 node 版本无关）。
- `settings.json` 的 statusLine 改为：`node "C:/Users/Administrator/.claude/tools/ccusage-lite/bin/ccu.js" statusline`。
