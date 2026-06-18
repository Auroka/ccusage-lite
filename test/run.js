'use strict';
// 零依赖核心单测，当前 node 直接跑：node test/run.js
var ccu = require('../bin/ccu.js');
var fs = require('fs');
var os = require('os');
var path = require('path');

var passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function approx(a, b) { return Math.abs(a - b) < 1e-6; }

// 1. extractRecord 正确提取四维 token
(function () {
  var line = {
    requestId: 'req1',
    sessionId: 's1',
    cwd: 'C:\\proj',
    timestamp: '2026-06-17T03:00:00.000Z',
    message: {
      id: 'msg1', model: 'claude-opus-4-8',
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 }
    }
  };
  var r = ccu.extractRecord(line);
  ok('extractRecord 提取 token', r && r.input === 10 && r.output === 20 && r.cacheWrite === 30 && r.cacheRead === 40);
  ok('extractRecord 提取元信息', r.id === 'msg1' && r.requestId === 'req1' && r.model === 'claude-opus-4-8');
  ok('非用量行返回 null', ccu.extractRecord({ message: { role: 'user' } }) === null);
})();

// 2. 去重：同 id|requestId 多次只计一次
(function () {
  var agg = ccu.newAgg();
  var rec = { id: 'm', requestId: 'r', model: 'claude-opus-4-8', sessionId: '', cwd: '', ts: '',
    input: 100, output: 0, cacheWrite: 0, cacheRead: 0 };
  ccu.addRecord(agg, rec);
  ccu.addRecord(agg, rec);
  ccu.addRecord(agg, rec);
  ok('去重后只计一次', agg.totals.input === 100 && agg.count === 1);
})();

// 3. 四维累计正确（不同记录）
(function () {
  var agg = ccu.newAgg();
  ccu.addRecord(agg, { id: 'a', requestId: '1', model: 'x', sessionId: '', cwd: '', ts: '', input: 1, output: 2, cacheWrite: 3, cacheRead: 4 });
  ccu.addRecord(agg, { id: 'b', requestId: '2', model: 'x', sessionId: '', cwd: '', ts: '', input: 10, output: 20, cacheWrite: 30, cacheRead: 40 });
  var t = agg.totals;
  ok('四维累计', t.input === 11 && t.output === 22 && t.cacheWrite === 33 && t.cacheRead === 44);
  ok('totalTok', ccu.totalTok(t) === 110);
})();

// 4. 计价：精确 key 与子串回退
(function () {
  var exact = ccu.costOf({ model: 'claude-opus-4-8', input: 1e6, output: 0, cacheWrite: 0, cacheRead: 0 });
  ok('opus 精确定价 input=$5', approx(exact, 5));
  var fb = ccu.priceFor('claude-opus-4-8-some-proxy-suffix');
  ok('未知后缀按 opus 回退', fb && fb.input === 5);
  var sonnet = ccu.priceFor('anthropic/claude-sonnet-4-6');
  ok('sonnet 子串回退', sonnet && sonnet.input === 3);
  ok('完全未知模型无价', ccu.priceFor('gpt-4') === null);
})();

// 4b. 带日期/代理后缀的精确定价：最长前缀匹配，不得退到通用 opus 低估价
(function () {
  // 旧 Opus 4/4.1 是 $15/$75，带日期后缀不能被当成新 Opus 的 $5/$25
  ok('opus-4-1 带后缀仍 $15', ccu.priceFor('claude-opus-4-1-20250805').input === 15);
  ok('opus-4 带后缀仍 $15', ccu.priceFor('claude-opus-4-20250514').input === 15);
  // 新 Opus 4.8 带后缀仍 $5；不能被更短的 claude-opus-4 抢走
  ok('opus-4-8 带后缀仍 $5', ccu.priceFor('claude-opus-4-8-20260601').input === 5);
})();

// 4b2. provider 前缀（anthropic/、openrouter/）也要剥离后做最长前缀匹配
(function () {
  ok('anthropic 前缀 opus-4-1 仍 $15', ccu.priceFor('anthropic/claude-opus-4-1-20250805').input === 15);
  ok('openrouter 前缀 opus-4 仍 $15', ccu.priceFor('openrouter/claude-opus-4-20250514').input === 15);
  ok('anthropic 前缀 opus-4-8 仍 $5', ccu.priceFor('anthropic/claude-opus-4-8-20260601').input === 5);
  ok('anthropic 前缀 sonnet-4-6 仍 $3', ccu.priceFor('anthropic/claude-sonnet-4-6-20260601').input === 3);
  ok('完全未知模型仍无价', ccu.priceFor('openrouter/gpt-4') === null);
  // Claude Code 开 1M 时 model.id 带 [1m] 标记，需剥离后命中
  ok('opus-4-8[1m] 命中 $5', ccu.priceFor('claude-opus-4-8[1m]').input === 5);
})();

// 4c. 上下文窗口：按模型 id 命中 contextWindows，未命中回落兜底
(function () {
  ok('opus-4-8 命中 1M', ccu.contextWindowFor('claude-opus-4-8') === 1000000);
  ok('opus-4-8 带后缀命中 1M', ccu.contextWindowFor('claude-opus-4-8-20260601') === 1000000);
  ok('sonnet-4-6 命中 1M', ccu.contextWindowFor('claude-sonnet-4-6') === 1000000);
  // provider 前缀也要剥离后命中
  ok('anthropic 前缀 sonnet-4-6 命中 1M', ccu.contextWindowFor('anthropic/claude-sonnet-4-6-20260601') === 1000000);
  ok('anthropic 前缀 opus-4-8 命中 1M', ccu.contextWindowFor('anthropic/claude-opus-4-8-20260601') === 1000000);
  // Claude Code 实测：开 1M 时 model.id 带 [1m] 标记，剥离后才命中（否则 394k/200k=197% 这种 bug）
  ok('opus-4-8[1m] 命中 1M', ccu.contextWindowFor('claude-opus-4-8[1m]') === 1000000);
  ok('anthropic 前缀 + [1m] 命中 1M', ccu.contextWindowFor('anthropic/claude-opus-4-8[1m]') === 1000000);
  // 4.5 不在官方 1M long context 列表，回落兜底 200000
  ok('opus-4-5 非 1M 回落兜底', ccu.contextWindowFor('claude-opus-4-5') === 200000);
  ok('sonnet-4-5 非 1M 回落兜底', ccu.contextWindowFor('claude-sonnet-4-5') === 200000);
  // haiku-4-5、未知、带前缀的未知都回落兜底
  ok('haiku-4-5 回落兜底', ccu.contextWindowFor('claude-haiku-4-5') === 200000);
  ok('anthropic 前缀 haiku 回落兜底', ccu.contextWindowFor('anthropic/claude-haiku-4-5') === 200000);
  ok('未知模型回落兜底', ccu.contextWindowFor('gpt-4') === 200000);
})();

// 5. localDay 解析与坏值
(function () {
  ok('localDay 解析 ISO', /^\d{4}-\d{2}-\d{2}$/.test(ccu.localDay('2026-06-17T03:00:00.000Z')));
  ok('localDay 坏值返回空', ccu.localDay('not-a-date') === '');
  ok('localDay 空返回空', ccu.localDay('') === '');
})();

// 6. statusline 渲染格式正确且不抛错
(function () {
  var s = { input: 5e5, output: 5e5, cacheWrite: 0, cacheRead: 0, cost: 0.85 };
  var t = { input: 5e6, output: 0, cacheWrite: 0, cacheRead: 0, cost: 3.2 };
  var out = ccu.renderStatusline('Opus 4.8', 50000, s, t);
  ok('statusline 含模型名', out.indexOf('Opus 4.8') >= 0);
  ok('statusline 含上下文', out.indexOf('上下文') >= 0);
  ok('statusline 含会话/今日/参考', out.indexOf('会话') >= 0 && out.indexOf('今日') >= 0 && out.indexOf('参考') >= 0);
  ok('statusline 单行', out.indexOf('\n') < 0);
})();

// 7. fmtTok 量级
(function () {
  ok('fmtTok K', ccu.fmtTok(1500) === '1.5K');
  ok('fmtTok M', ccu.fmtTok(5.4e6) === '5.40M');
  ok('fmtTok 原值', ccu.fmtTok(42) === '42');
})();

// 7b. 表格数字/金额/宽度格式化
(function () {
  ok('fmtInt 千分位', ccu.fmtInt(6170241) === '6,170,241');
  ok('fmtInt 小数四舍五入', ccu.fmtInt(0) === '0' && ccu.fmtInt(999) === '999');
  ok('fmtMoney 千分位', ccu.fmtMoney(1126.14) === '$1,126.14');
  ok('fmtMoney 两位小数', ccu.fmtMoney(5.3) === '$5.30');
  ok('dispWidth 中文算2列', ccu.dispWidth('日期') === 4);
  ok('dispWidth 混合', ccu.dispWidth('总Token') === 7);
})();

// 8. dayKeyOffset 格式与单调性
(function () {
  ok('dayKeyOffset 格式', /^\d{4}-\d{2}-\d{2}$/.test(ccu.dayKeyOffset(0)));
  ok('dayKeyOffset 越早越小', ccu.dayKeyOffset(6) < ccu.dayKeyOffset(0));
})();

// 8b. node14 禁用语法扫描：源码不得出现 node14 不支持的 API/语法
(function () {
  var src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'ccu.js'), 'utf8');
  var banned = [
    { re: /\bstructuredClone\s*\(/, name: 'structuredClone' },
    { re: /\bObject\.hasOwn\s*\(/, name: 'Object.hasOwn' },
    { re: /\.at\s*\(/, name: 'Array.prototype.at' },
    { re: /\.findLast\s*\(/, name: 'findLast' },
    { re: /[^.\w]fetch\s*\(/, name: 'fetch' }
  ];
  var hit = null;
  for (var i = 0; i < banned.length; i++) { if (banned[i].re.test(src)) { hit = banned[i].name; break; } }
  ok('node14 禁用语法未出现' + (hit ? '（命中 ' + hit + '）' : ''), hit === null);
})();

// ---- 异步测试协调：所有 promise 完成后再打印汇总 ----
var pending = 0;
function asyncStart() { pending++; }
function asyncDone() { pending--; if (pending === 0) finish(); }

// 9. buildAgg sinceDay 区间过滤：只统计 >= sinceDay 的记录
(function () {
  asyncStart();
  var tmp = path.join(os.tmpdir(), 'ccu-test-range-' + process.pid + '.jsonl');
  function rec(day, id, inTok) {
    return JSON.stringify({
      requestId: id, sessionId: 's', cwd: '', timestamp: day + 'T12:00:00.000Z',
      message: { id: id, model: 'claude-opus-4-8', usage: { input_tokens: inTok, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
    });
  }
  // 用相对 today 的偏移构造区间内/外的记录，避免硬编码日期
  var inRange = ccu.dayKeyOffset(2);   // 2 天前，落在近一周内
  var outRange = ccu.dayKeyOffset(20); // 20 天前，近一周之外
  fs.writeFileSync(tmp, rec(inRange, 'r-in', 100) + '\n' + rec(outRange, 'r-out', 999) + '\n', 'utf8');
  ccu.buildAgg([tmp], { sinceDay: ccu.dayKeyOffset(6) }).then(function (agg) {
    ok('sinceDay 只计区间内记录', agg.totals.input === 100 && agg.count === 1);
    try { fs.unlinkSync(tmp); } catch (e) {}
    asyncDone();
  });
})();

// 10. 跨日 session：同文件同 session 含昨天+今天记录，day 过滤后只计今天
(function () {
  asyncStart();
  var tmp = path.join(os.tmpdir(), 'ccu-test-session-' + process.pid + '.jsonl');
  function rec(day, id, inTok) {
    return JSON.stringify({
      requestId: id, sessionId: 'sess-x', cwd: 'C:\\proj', timestamp: day + 'T12:00:00.000Z',
      message: { id: id, model: 'claude-opus-4-8', usage: { input_tokens: inTok, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
    });
  }
  var today = ccu.dayKeyOffset(0);
  var yesterday = ccu.dayKeyOffset(1);
  fs.writeFileSync(tmp, rec(yesterday, 'r-y', 500) + '\n' + rec(today, 'r-t', 100) + '\n', 'utf8');
  // 模拟 cmdSession 的口径：mtime 文件被选中，但只统计今日记录
  ccu.buildAgg([tmp], { day: today }).then(function (agg) {
    var s = agg.bySession['sess-x'];
    ok('跨日 session 只计今天', !!s && s.acc.input === 100 && agg.totals.input === 100 && agg.count === 1);
    try { fs.unlinkSync(tmp); } catch (e) {}
    asyncDone();
  });
})();

function finish() {
  console.log('');
  console.log('通过 ' + passed + ' / ' + (passed + failed));
  if (failed > 0) { process.exit(1); }
}
