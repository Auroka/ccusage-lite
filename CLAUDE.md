# ccusage-lite

ccusage 的轻量替代，命令 `ccu`：统计 Claude Code 本地用量，并提供 statusline。

## 为什么存在（第一性原理）
全局 statusLine 进程会用**当前激活的 node 版本**启动。前端切到 node14/16/18 维护老项目时，需要 node20+ 的 ccusage 直接崩溃，状态栏报错/空白。
**第一约束 = node14 到最新版任意 node 下零崩溃运行。** 这条高于一切，决定所有技术选型。

## 硬约束（不可违反）
1. **零运行时依赖**：只用 node 内置 `fs`/`path`/`os`/`readline`，不引入任何 npm 包。
2. **node14 语法兼容**：禁用 `fetch`(18+)、`structuredClone`(17+)、`Array.prototype.at`(16.6+)、`Object.hasOwn`(16.9+)、`Array.prototype.findLast`(18+)、顶层 `await`、`#私有字段`。允许 `?.`、`??`（14.0 起支持）。
3. **CommonJS**：用 `require`/`module.exports`，不用 ESM `import`。
4. **不联网**：定价表静态内置在 `lib/pricing.json`。
5. **statusline 永不抛错**：每次渲染都 try/catch 兜底，任何异常输出降级行而非崩溃；坏的单行 JSON 跳过。

## 关键事实
- 数据源 `~/.claude/projects/**/*.jsonl`，每行一条记录，assistant 行带 `message.usage`。
- token 四维度分开累计：`input` / `output` / `cache_creation` / `cache_read`。缓存 token 占大头。
- 去重：按 `message.id` + `requestId` 组合，避免 resume/retry 导致同一请求重复计数。
- 定价口径：官方现价（Opus 4.x = $5/$25、Sonnet 4.6 = $3/$15、Haiku 4.5 = $1/$5 每百万）。4.x 均 1M 上下文、标准定价、**无长上下文溢价**。
- 代理倍率：`config.json` 的 `multiplier`（本机=2）。花费展示 = 官方价 × multiplier，仍标"参考"。改倍率只改 config，不动代码。
- 上下文占用（statusline）：transcript 里**最新一条主链 assistant**（排除 `isSidechain` 子代理）的 `input + cache_read + cache_creation`。分母 = `config.json` 的 `contextWindow`。
- "今日"优化：今日记录只可能在 mtime 是今天的文件里，statusline/today 只解析这些文件。

## 命令
`ccu` / `ccu week`（近一周，默认）· `month`（近一月）· `today` · `session`（今日各会话）· `total` · `statusline`（读 stdin，供 settings.json 调用）· `help`。
除 statusline 外，输出均为**中文带边框表格**（按天或会话分组：合计行 + 模型/会话子行 + 末尾整段合计）。

## 目录结构
```
bin/ccu.js        # 单文件主程序（CLI + statusline）
lib/pricing.json  # 官方定价表
config.json       # multiplier 倍率 + contextWindow
README.md         # 用户使用说明
INSTALL.md        # 安装指南（给 agent，分 Windows/macOS）
docs/spec.md      # 设计文档
test/run.js       # 核心单测
```

## 安装
见 [INSTALL.md](INSTALL.md)。核心：把命令 shim（Windows）或软链（macOS）指向 `bin/ccu.js`，放进 PATH 目录；可选把 statusline 接入 Claude Code `settings.json`。

## 修改本项目时
- 改任何代码后，先跑 `node test/run.js`，再用真实数据 `node bin/ccu.js today` 验证。
- 加新语法前先对照硬约束第 2 条确认 node14 支持。
- 文档默认中文；代码、命令、变量名用英文，注释可用中文。
