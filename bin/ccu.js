#!/usr/bin/env node
'use strict';

/*
 * ccusage-lite —— ccusage 的轻量替代品。
 * 硬约束：node14 → 最新版任意 node 零崩溃运行；零依赖；CommonJS。
 * 详见同目录 ../CLAUDE.md。
 */

var fs = require('fs');
var path = require('path');
var os = require('os');
var readline = require('readline');

// ---------- 定价表（静态内置，参考用） ----------
var PRICING = loadPricing();

function loadPricing() {
  try {
    var p = path.join(__dirname, '..', 'lib', 'pricing.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { models: {}, fallback: {} };
  }
}

// 本地配置：multiplier 代理倍率；contextWindow 上下文窗口（算占比用）。读 config.json，容错回落默认值
var CFG = loadConfig();
var MULTIPLIER = CFG.multiplier;
var CONTEXT_WINDOW = CFG.contextWindow;

function loadConfig() {
  // contextWindow 是兜底估算分母（默认 200000）；contextWindows 按模型 id 精确覆盖
  // （如 1M 上下文的 opus 4.5+/sonnet 4.5+），不保证自动识别所有模型。
  var cfg = { multiplier: 1, contextWindow: 200000, contextWindows: {} };
  try {
    var p = path.join(__dirname, '..', 'config.json');
    var c = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (c && typeof c.multiplier === 'number' && isFinite(c.multiplier) && c.multiplier > 0) cfg.multiplier = c.multiplier;
    if (c && typeof c.contextWindow === 'number' && isFinite(c.contextWindow) && c.contextWindow > 0) cfg.contextWindow = c.contextWindow;
    if (c && c.contextWindows && typeof c.contextWindows === 'object') cfg.contextWindows = c.contextWindows;
  } catch (e) {}
  return cfg;
}

// 把模型 id 拆成候选，供前缀匹配逐个试。保留原串作 fallback。node14 兼容。
// 处理两类污染：
//   1) provider 前缀：anthropic/claude-opus-4-1-... → 也试 claude-opus-4-1-...
//   2) 上下文/变体标记：Claude Code 在开 1M 时 model.id 形如 claude-opus-4-8[1m]，
//      去掉 [..] 才能命中 contextWindows / pricing 的裸 key。
function modelCandidates(model) {
  var raw = String(model || '');
  var seen = Object.create(null);
  var out = [];
  function add(s) {
    if (s && !seen[s]) { seen[s] = true; out.push(s); }
    // 同步加一份去掉 provider 前缀的最后一段
    var slash = s ? s.lastIndexOf('/') : -1;
    if (slash >= 0 && slash < s.length - 1) {
      var tail = s.slice(slash + 1);
      if (tail && !seen[tail]) { seen[tail] = true; out.push(tail); }
    }
  }
  add(raw);
  var noBracket = raw.replace(/\[[^\]]*\]/g, '');  // 去掉 [1m] 这类标记
  if (noBracket !== raw) add(noBracket);
  return out;
}

// 在一张 key→值 的表里对模型 id 做最长前缀匹配（精确 key 或带后缀的 "key-" 前缀），
// 跨所有候选选全局最长 key。未命中返回 null。priceFor / contextWindowFor 共用。
function longestPrefixMatch(table, model) {
  var cands = modelCandidates(model);
  var bestKey = null;
  for (var c = 0; c < cands.length; c++) {
    var m = cands[c];
    for (var key in table) {
      if (m === key || m.indexOf(key + '-') === 0) {
        if (bestKey === null || key.length > bestKey.length) bestKey = key;
      }
    }
  }
  return bestKey === null ? null : table[bestKey];
}

// 按当前模型 id 取上下文窗口：最长前缀匹配（含 provider 前缀）→ 回落全局 contextWindow。
// statusline 占比分母用，避免在非 1M 模型上把占比算偏。
function contextWindowFor(modelId) {
  var hit = longestPrefixMatch(CFG.contextWindows || {}, modelId);
  return (typeof hit === 'number' && hit > 0) ? hit : CONTEXT_WINDOW;
}

// ---------- 数据发现层 ----------
function projectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// 递归列出所有 .jsonl（node14 无 withFileTypes recursive，手写递归）
function listJsonlFiles(dir) {
  var out = [];
  var entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return out; }
  for (var i = 0; i < entries.length; i++) {
    var full = path.join(dir, entries[i]);
    var st;
    try { st = fs.statSync(full); } catch (e2) { continue; }
    if (st.isDirectory()) {
      var sub = listJsonlFiles(full);
      for (var j = 0; j < sub.length; j++) out.push(sub[j]);
    } else if (st.isFile() && full.slice(-6) === '.jsonl') {
      out.push(full);
    }
  }
  return out;
}

// 按 mtime 过滤（"今日"只可能在今天被追加过的文件里）
function filesSince(ms) {
  var all = listJsonlFiles(projectsDir());
  if (!ms) return all;
  var out = [];
  for (var i = 0; i < all.length; i++) {
    try {
      if (fs.statSync(all[i]).mtimeMs >= ms) out.push(all[i]);
    } catch (e) {}
  }
  return out;
}

// ---------- 解析层 ----------
function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

// 从一行解析后的对象提取用量记录；非用量行返回 null
function extractRecord(obj) {
  if (!obj || !obj.message || !obj.message.usage) return null;
  var msg = obj.message;
  var u = msg.usage;
  return {
    id: msg.id || '',
    requestId: obj.requestId || '',
    model: msg.model || 'unknown',
    sessionId: obj.sessionId || '',
    cwd: obj.cwd || '',
    ts: obj.timestamp || '',
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    cacheRead: num(u.cache_read_input_tokens)
  };
}

// 流式逐行读取，坏行跳过，文件出错跳过。返回 Promise。
function parseFile(file, onRecord) {
  return new Promise(function (resolve) {
    var stream;
    try { stream = fs.createReadStream(file, { encoding: 'utf8' }); }
    catch (e) { return resolve(); }
    stream.on('error', function () { resolve(); });
    var rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', function (line) {
      if (!line) return;
      var obj;
      try { obj = JSON.parse(line); } catch (e) { return; } // 坏行跳过
      var rec = extractRecord(obj);
      if (rec) onRecord(rec);
    });
    rl.on('error', function () { resolve(); });
    rl.on('close', function () { resolve(); });
  });
}

// ---------- 聚合层 ----------
function zero() { return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 }; }
function totalTok(a) { return a.input + a.output + a.cacheWrite + a.cacheRead; }

function newAgg() {
  return {
    seen: Object.create(null),   // 去重表
    totals: zero(),
    byModel: Object.create(null),
    byDay: Object.create(null),
    bySession: Object.create(null),
    count: 0
  };
}

function bump(acc, rec, cost) {
  acc.input += rec.input;
  acc.output += rec.output;
  acc.cacheWrite += rec.cacheWrite;
  acc.cacheRead += rec.cacheRead;
  acc.cost += cost;
}

function addRecord(agg, rec) {
  // 去重：同一 id|requestId 只计一次（resume/retry 会重复写）
  if (rec.id) {
    var key = rec.id + '|' + rec.requestId;
    if (agg.seen[key]) return;
    agg.seen[key] = true;
  }
  var cost = costOf(rec);
  bump(agg.totals, rec, cost);

  if (!agg.byModel[rec.model]) agg.byModel[rec.model] = zero();
  bump(agg.byModel[rec.model], rec, cost);

  var day = localDay(rec.ts);
  if (day) {
    if (!agg.byDay[day]) agg.byDay[day] = zero();
    bump(agg.byDay[day], rec, cost);
    // 同时按 天×模型 二维累计，供表格的模型子行用
    if (!agg.byDay[day].models) agg.byDay[day].models = Object.create(null);
    if (!agg.byDay[day].models[rec.model]) agg.byDay[day].models[rec.model] = zero();
    bump(agg.byDay[day].models[rec.model], rec, cost);
  }

  if (rec.sessionId) {
    var s = agg.bySession[rec.sessionId];
    if (!s) { s = { acc: zero(), cwd: rec.cwd || '', lastTs: rec.ts || '' }; agg.bySession[rec.sessionId] = s; }
    bump(s.acc, rec, cost);
    if (rec.ts > s.lastTs) { s.lastTs = rec.ts; if (rec.cwd) s.cwd = rec.cwd; }
  }

  agg.count++;
}

// 构建聚合：
//   opts.day      只统计指定本地日期的记录（精确单日）
//   opts.sinceDay 只统计本地日期 >= 该 key 的记录（字典序比较，含当天起的区间）
function buildAgg(files, opts) {
  opts = opts || {};
  var agg = newAgg();
  var i = 0;
  function next() {
    if (i >= files.length) return Promise.resolve(agg);
    var f = files[i++];
    return parseFile(f, function (rec) {
      if (opts.day && localDay(rec.ts) !== opts.day) return;
      if (opts.sinceDay) {
        var d = localDay(rec.ts);
        if (!d || d < opts.sinceDay) return;
      }
      addRecord(agg, rec);
    }).then(next);
  }
  return next();
}

// ---------- 计价层 ----------
function priceFor(model) {
  // 最长前缀匹配（已含 provider 前缀剥离）：精确 key 或带日期/代理后缀的变体，
  // 如 anthropic/claude-opus-4-1-20250805 命中 claude-opus-4-1，避免被更短的
  // claude-opus-4 抢走、或退到通用 opus 低估价。
  var hit = longestPrefixMatch(PRICING.models || {}, model);
  if (hit) return hit;
  // 仍未命中再按系列子串回退（原串小写）
  var fb = PRICING.fallback || {};
  var lc = String(model).toLowerCase();
  if (lc.indexOf('opus') >= 0 && fb.opus) return fb.opus;
  if (lc.indexOf('sonnet') >= 0 && fb.sonnet) return fb.sonnet;
  if (lc.indexOf('haiku') >= 0 && fb.haiku) return fb.haiku;
  return null;
}

function costOf(rec) {
  var p = priceFor(rec.model);
  if (!p) return 0;
  return (rec.input * p.input +
          rec.output * p.output +
          rec.cacheWrite * p.cacheWrite +
          rec.cacheRead * p.cacheRead) / 1e6;
}

// ---------- 时间 / 格式化 ----------
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function localDay(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function todayKey() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function startOfTodayMs() {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
// n 天前的本地零点毫秒（n=0 即今天零点）
function startMsOffset(n) {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.getTime();
}
// n 天前的本地日期 key（YYYY-MM-DD），可作字符串字典序比较
function dayKeyOffset(n) {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function fmtTok(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function fmtUsd(n) { return '$' + n.toFixed(2); }
function fmtPct(n) { return (n * 100).toFixed(0) + '%'; }

// 整数加千分位：123456 -> "123,456"
function fmtInt(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
// 金额带千分位：$1,126.14
function fmtMoney(n) {
  var parts = n.toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '$' + parts.join('.');
}

// ---------- 表格渲染（终端中文等宽对齐） ----------
// 单字符显示宽度：CJK/全角算 2 列，其余算 1 列
function charW(cp) {
  if (cp >= 0x1100 && (
      cp <= 0x115F ||
      cp === 0x2329 || cp === 0x232A ||
      (cp >= 0x2E80 && cp <= 0x303E) ||
      (cp >= 0x3041 && cp <= 0x33FF) ||
      (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0x4E00 && cp <= 0x9FFF) ||
      (cp >= 0xA000 && cp <= 0xA4CF) ||
      (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE30 && cp <= 0xFE4F) ||
      (cp >= 0xFF00 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6))) return 2;
  return 1;
}
function dispWidth(s) {
  s = String(s);
  var w = 0;
  for (var i = 0; i < s.length; i++) w += charW(s.charCodeAt(i));
  return w;
}
function repeat(ch, n) { return n > 0 ? new Array(n + 1).join(ch) : ''; }
// 按显示宽度补齐：align='r' 右对齐（数字），否则左对齐
function padTo(s, width, align) {
  s = String(s);
  var gap = width - dispWidth(s);
  if (gap <= 0) return s;
  var sp = repeat(' ', gap);
  return align === 'r' ? sp + s : s + sp;
}
function tableBorder(widths, left, mid, right) {
  var parts = [];
  for (var i = 0; i < widths.length; i++) parts.push(repeat('─', widths[i] + 2));
  return left + parts.join(mid) + right;
}
function tableRow(cells, widths, aligns) {
  var out = '│';
  for (var i = 0; i < cells.length; i++) out += ' ' + padTo(cells[i], widths[i], aligns[i]) + ' │';
  return out;
}
// rows 中的元素可为单元格数组，或字符串 'sep'（插入一条分隔线）
function printTable(headers, rows, aligns) {
  var widths = [];
  for (var c = 0; c < headers.length; c++) widths[c] = dispWidth(headers[c]);
  for (var r = 0; r < rows.length; r++) {
    if (rows[r] === 'sep') continue;
    for (var c2 = 0; c2 < headers.length; c2++) {
      var w = dispWidth(rows[r][c2]);
      if (w > widths[c2]) widths[c2] = w;
    }
  }
  print(tableBorder(widths, '┌', '┬', '┐'));
  print(tableRow(headers, widths, aligns));
  print(tableBorder(widths, '├', '┼', '┤'));
  for (var k = 0; k < rows.length; k++) {
    if (rows[k] === 'sep') { print(tableBorder(widths, '├', '┼', '┤')); continue; }
    print(tableRow(rows[k], widths, aligns));
  }
  print(tableBorder(widths, '└', '┴', '┘'));
}

// 把聚合渲染成「按天分组、含合计行 + 模型子行」的花费统计表
function printDayTable(agg) {
  var headers = ['日期', '模型', '输入', '输出', '缓存写', '缓存读', '总Token', '花费(参考)'];
  var aligns = ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'r'];
  function cells(date, model, a) {
    return [date, model,
      fmtInt(a.input), fmtInt(a.output), fmtInt(a.cacheWrite), fmtInt(a.cacheRead),
      fmtInt(totalTok(a)), fmtMoney(a.cost * MULTIPLIER)];
  }
  var days = Object.keys(agg.byDay).sort().reverse();
  if (!days.length) { print('（无数据）'); return; }
  var rows = [];
  for (var i = 0; i < days.length; i++) {
    var d = days[i];
    var dt = agg.byDay[d];
    rows.push(cells(d, '合计', dt));
    var models = dt.models ? Object.keys(dt.models) : [];
    models.sort(function (x, y) { return totalTok(dt.models[y]) - totalTok(dt.models[x]); });
    for (var m = 0; m < models.length; m++) {
      if (totalTok(dt.models[models[m]]) === 0) continue; // 跳过零 token（如 <synthetic>）
      rows.push(cells('', '- ' + models[m], dt.models[models[m]]));
    }
    rows.push('sep');
  }
  // 末尾整段合计
  rows.push(cells('合计', '', agg.totals));
  printTable(headers, rows, aligns);
}

// 各命令底部说明：倍率生效时如实标注口径
function noteLine() {
  if (MULTIPLIER !== 1) {
    return '注：花费 = 官方定价 × ' + MULTIPLIER + ' 倍率（代理），为实际扣费估算。';
  }
  return '注：花费为官方定价参考，实际以代理结算为准。';
}

// statusline 渲染（纯函数，便于测试）。显示当前上下文占用 + 花费
// ctxWindow 省略时回落全局 CONTEXT_WINDOW（保持旧测试签名兼容）
function renderStatusline(model, ctxTokens, session, today, ctxWindow) {
  var W = (typeof ctxWindow === 'number' && ctxWindow > 0) ? ctxWindow : CONTEXT_WINDOW;
  return '🤖 ' + model +
    ' │ 上下文 ' + fmtTok(ctxTokens) + ' (' + fmtPct(ctxTokens / W) + ')' +
    ' │ 当前会话 ' + fmtUsd(session.cost * MULTIPLIER) + ' (参考)' +
    ' │ 今日 ' + fmtUsd(today.cost * MULTIPLIER) + ' (参考)';
}

// 当前会话上下文占用 = 最新一条主链 assistant 记录的 input+cache_read+cache_creation
function sessionContext(file) {
  return new Promise(function (resolve) {
    var last = 0;
    var stream;
    try { stream = fs.createReadStream(file, { encoding: 'utf8' }); }
    catch (e) { return resolve(0); }
    stream.on('error', function () { resolve(last); });
    var rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', function (line) {
      if (!line) return;
      var o;
      try { o = JSON.parse(line); } catch (e) { return; }
      if (o && o.isSidechain) return; // 排除子代理链，只看主对话
      var u = o && o.message && o.message.usage;
      if (!u) return;
      last = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    });
    rl.on('error', function () { resolve(last); });
    rl.on('close', function () { resolve(last); });
  });
}

// ---------- 输出 ----------
function print(s) { process.stdout.write((s == null ? '' : s) + '\n'); }

// ---------- 命令 ----------
function cmdToday() {
  var day = todayKey();
  var files = filesSince(startOfTodayMs());
  return buildAgg(files, { day: day }).then(function (agg) {
    print('Claude 今日用量  ' + day + '   请求数 ' + agg.count);
    printDayTable(agg);
    print(noteLine());
  });
}

// 近 N 天的每日用量（含当天）。days=7 即近一周，days=30 即近一月
function cmdRange(days, title) {
  var sinceDay = dayKeyOffset(days - 1);
  var files = filesSince(startMsOffset(days - 1));
  return buildAgg(files, { sinceDay: sinceDay }).then(function (agg) {
    print('Claude ' + title + '用量  ' + sinceDay + ' ~ ' + todayKey() + '   请求数 ' + agg.count);
    printDayTable(agg);
    print(noteLine());
  });
}

function cmdTotal() {
  var files = filesSince(0);
  return buildAgg(files, {}).then(function (agg) {
    print('Claude 累计用量（全部）   请求数 ' + agg.count);
    printDayTable(agg);
    print(noteLine());
  });
}

// 把会话聚合渲染成「每会话一行 + 末尾合计」的表格
function printSessionTable(agg) {
  var headers = ['会话', '最后活跃', '输入', '输出', '缓存写', '缓存读', '总Token', '花费(参考)'];
  var aligns = ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'r'];
  function cells(name, lastTs, a) {
    return [name, lastTs,
      fmtInt(a.input), fmtInt(a.output), fmtInt(a.cacheWrite), fmtInt(a.cacheRead),
      fmtInt(totalTok(a)), fmtMoney(a.cost * MULTIPLIER)];
  }
  var ids = Object.keys(agg.bySession);
  if (!ids.length) { print('（今日无活跃会话）'); return; }
  // 最近活跃的排在最上
  ids.sort(function (a, b) {
    var ta = agg.bySession[a].lastTs, tb = agg.bySession[b].lastTs;
    return ta < tb ? 1 : (ta > tb ? -1 : 0);
  });
  var rows = [];
  var sum = zero();
  for (var i = 0; i < ids.length; i++) {
    var s = agg.bySession[ids[i]];
    var name = s.cwd ? basename(s.cwd) : ids[i].slice(0, 8);
    var lastTs = s.lastTs ? s.lastTs.slice(0, 19).replace('T', ' ') : '';
    rows.push(cells(name, lastTs, s.acc));
    bump(sum, s.acc, s.acc.cost); // 合计行只累加展示出的会话
  }
  rows.push('sep');
  rows.push(cells('合计', '', sum));
  printTable(headers, rows, aligns);
}

function cmdSession() {
  var day = todayKey();
  var files = filesSince(startOfTodayMs());
  // 必须按今日日期过滤：今天被追加过的 transcript 往往还含昨天及更早的记录，
  // 不过滤会把旧日期 token 也算进"今日会话"，高估今日用量。
  return buildAgg(files, { day: day }).then(function (agg) {
    print('Claude 会话用量（今日活跃）   会话数 ' + Object.keys(agg.bySession).length);
    printSessionTable(agg);
    print(noteLine());
  });
}

function basename(p) {
  var s = String(p).replace(/[\\/]+$/, '');
  var idx = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return idx >= 0 ? s.slice(idx + 1) : s;
}

// 同步读取 stdin（Claude Code 注入的 JSON）
function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}

function cmdStatusline() {
  var model = 'Claude';
  var modelId = '';
  var transcript = '';
  try {
    var raw = readStdin();
    if (raw) {
      var j = JSON.parse(raw);
      if (j.model) {
        if (j.model.display_name) model = j.model.display_name;
        else if (j.model.id) model = j.model.id;
        modelId = j.model.id || '';   // 用 id 查上下文窗口（display_name 不稳定）
      }
      transcript = j.transcript_path || '';
    }
  } catch (e) {}

  // 当前会话：直接解析 transcript 文件
  var sessionP = transcript
    ? buildAgg([transcript], {}).then(function (a) { return a.totals; })['catch'](function () { return zero(); })
    : Promise.resolve(zero());

  // 今日：只扫 mtime=今天的文件，再按本地日期过滤
  var todayP = buildAgg(filesSince(startOfTodayMs()), { day: todayKey() })
    .then(function (a) { return a.totals; })['catch'](function () { return zero(); });

  // 当前会话上下文占用
  var ctxP = transcript ? sessionContext(transcript) : Promise.resolve(0);

  var win = contextWindowFor(modelId);
  return Promise.all([ctxP, sessionP, todayP]).then(function (r) {
    process.stdout.write(renderStatusline(model, r[0], r[1], r[2], win) + '\n');
  });
}

function printHelp() {
  print('ccusage-lite —— Claude Code 用量统计（node14+ 兼容）');
  print('');
  print('用法: ccu [命令]');
  print('  week        近一周每日用量（默认）');
  print('  month       近一月每日用量');
  print('  today       今日用量');
  print('  session     按会话拆分（今日活跃）');
  print('  total       全部累计');
  print('  statusline  读 stdin，供 settings.json 调用');
  print('  help        显示帮助');
}

// ---------- 入口 ----------
function main(argv) {
  var cmd = argv[0] || 'week';
  if (cmd === 'statusline') {
    // statusline 永不抛错：任何异常都降级输出
    return cmdStatusline()['catch'](function () {
      process.stdout.write('🤖 Claude\n');
    });
  }
  if (cmd === 'week') return cmdRange(7, '近一周');
  if (cmd === 'month') return cmdRange(30, '近一月');
  if (cmd === 'today') return cmdToday();
  if (cmd === 'session') return cmdSession();
  if (cmd === 'total') return cmdTotal();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { printHelp(); return Promise.resolve(); }
  print('未知命令: ' + cmd);
  printHelp();
  return Promise.resolve();
}

if (require.main === module) {
  main(process.argv.slice(2)).then(null, function (e) {
    process.stderr.write(String((e && e.stack) || e) + '\n');
    process.exit(1);
  });
}

// 导出供测试
module.exports = {
  extractRecord: extractRecord,
  addRecord: addRecord,
  newAgg: newAgg,
  zero: zero,
  costOf: costOf,
  priceFor: priceFor,
  localDay: localDay,
  fmtTok: fmtTok,
  totalTok: totalTok,
  renderStatusline: renderStatusline,
  buildAgg: buildAgg,
  dayKeyOffset: dayKeyOffset,
  fmtInt: fmtInt,
  fmtMoney: fmtMoney,
  dispWidth: dispWidth,
  contextWindowFor: contextWindowFor
};
