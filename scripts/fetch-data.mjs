// 每日抓取：18 只主动 ETF 的场内价 + 交易所 PCF 持仓快照。
// Node >= 20，无第三方依赖。跑法：`node scripts/fetch-data.mjs`
// 数据源（全部免费、无需 key，按顺序尝试，失败就换下一个）：
//   行情 1. 东方财富 push2  2. 腾讯 qt.gtimg.cn  3. 新浪 hq.sinajs.cn（需 Referer） 4. Yahoo Finance
//   PCF   上交所 query.sse.com.cn/commonQuery.do（两条 sqlId，见下）
//         深交所 www.szse.cn/api/report/ShowReport/data + reportdocs.static.szse.cn 的 XML
//         口径说明见 README：PCF 是申赎篮子估算，不等同精确持仓。
// 注意：本机直连东方财富/腾讯常超时或 502（代理/网络原因），GitHub Actions
// Runner 上通常可达。脚本对每个源都设 15 秒超时 + 重试，全部失败时以非零
// 退出，让 Action 变红，而不是静默写假数据。
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'public', 'data');
const etfs = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'etfs.json'), 'utf8'));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const TIMEOUT_MS = 15000;

function cstToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}
function cstWeekday(dateStr) {
  return new Date(dateStr + 'T12:00:00+08:00').getDay(); // 0 周日，6 周六
}
async function fetchText(url, headers = {}, { timeoutMs = TIMEOUT_MS, attempts = 2 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt === attempts) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}
// 深交所 PCF 是 GBK 编码的纯文本，必须按 GBK 解码，否则中文简称全是乱码。
async function fetchTextGBK(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return new TextDecoder('gbk').decode(buf);
}
async function fetchJson(url, headers = {}) {
  return JSON.parse(await fetchText(url, headers));
}
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  // 上交所 PCF 金额带 ￥ 和千分位逗号，先去掉再转数字
  const n = Number(String(v).replace(/[￥,，\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const normDay = (d) => {
  const s = String(d ?? '').trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s || '';
};
const secid = (e) => `${e.market === 'sh' ? 1 : 0}.${e.code}`;
const marketOf = (code) => (code.startsWith('6') || code.startsWith('9') ? 'sh' : 'sz');

// ---------- 行情 ----------
async function quotesEastmoney(list) {
  const secids = list.map(secid).join(',');
  const fields = 'f43,f44,f45,f46,f47,f48,f57,f58,f60,f62,f168,f169,f170,f171,f177';
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secids}&fields=${fields}&invt=2&fltt=2`;
  const json = await fetchJson(url);
  const data = json?.data;
  if (!data) throw new Error('eastmoney: empty data');
  const out = {};
  for (const d of data) {
    const price = num(d.f43);
    const prev = num(d.f60);
    if (price === null || prev === null) continue;
    out[d.f57] = {
      price,
      prevClose: prev,
      open: num(d.f46),
      high: num(d.f44),
      low: num(d.f45),
      volume: num(d.f47),
      turnover: num(d.f48),
      changePct: num(d.f170) ?? +(((price - prev) / prev) * 100).toFixed(2),
      source: 'eastmoney',
    };
  }
  return { data: out, tradingDate: null };
}
async function quotesTencent(list) {
  const q = list.map((e) => `s_${e.market}${e.code}`).join(',');
  const text = await fetchText(`https://qt.gtimg.cn/q=${q}`, {}, { timeoutMs: 8000, attempts: 1 });
  const out = {};
  let tradingDate = null;
  for (const line of text.split(';')) {
    const m = line.match(/v_s_\w+="(.*)"/);
    if (!m) continue;
    const p = m[1].split('~');
    if (!tradingDate) tradingDate = p.find((x) => /^\d{4}-\d{2}-\d{2}/.test(x))?.slice(0, 10) ?? null;
    // 注意：q=s_xxx 返回的是精简格式，与完整版字段完全不同：
    //   p[3]=现价，p[4]=涨跌额，p[5]=涨跌幅(%)，p[6]=成交量，p[7]=成交额；
    //   没有昨收/开盘/最高/最低。之前按完整格式把 p[4] 当昨收、p[5] 当开盘，
    //   昨收变成 0.005 这种涨跌额，涨跌幅就被算成 +19760% 之类的天文数字。
    const price = num(p[3]);
    const chg = num(p[4]);
    const changePct = num(p[5]);
    if (price === null || chg === null || changePct === null) continue;
    // A 股 ETF 日涨跌幅限 ±10%，超出即判定为源格式漂移，跳过本行走下一个源。
    if (Math.abs(changePct) > 10.5) continue;
    const prev = +(price - chg).toFixed(3);
    out[p[2]] = {
      price,
      prevClose: prev,
      open: null,
      high: null,
      low: null,
      volume: num(p[6]),
      turnover: num(p[7]),
      changePct,
      source: 'tencent',
    };
  }
  if (!Object.keys(out).length) throw new Error('tencent: no rows');
  return { data: out, tradingDate };
}
async function quotesSina(list) {
  const q = list.map((e) => `${e.market}${e.code}`).join(',');
  const text = await fetchText(`https://hq.sinajs.cn/list=${q}`, { Referer: 'https://finance.sina.com.cn' });
  const out = {};
  let tradingDate = null;
  for (const line of text.split('\n')) {
    const m = line.match(/hq_str_\w+="(.*)"/);
    if (!m) continue;
    const p = m[1].split(',');
    if (!tradingDate && /^\d{4}-\d{2}-\d{2}$/.test(p[30] ?? '')) tradingDate = p[30];
    const price = num(p[3]);
    const prev = num(p[2]);
    if (price === null || prev === null) continue;
    const code = line.match(/hq_str_(\w+)/)?.[1]?.replace(/^(sh|sz)/, '');
    out[code] = {
      price,
      prevClose: prev,
      open: num(p[1]),
      high: num(p[4]),
      low: num(p[5]),
      volume: num(p[8]),
      turnover: num(p[9]),
      changePct: +(((price - prev) / prev) * 100).toFixed(2),
      source: 'sina',
    };
  }
  if (!Object.keys(out).length) throw new Error('sina: no rows');
  return { data: out, tradingDate };
}
async function quotesYahoo(list) {
  const out = {};
  for (const e of list) {
    const suffix = e.market === 'sh' ? 'SS' : 'SZ';
    try {
      // 单次尝试、10 秒超时：Yahoo 只是最后兜底，别让 18 只 × 重试拖垮整个任务。
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${e.code}.${suffix}?range=5d&interval=1d`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) },
      );
      if (!res.ok) continue;
      const json = await res.json();
      const r = json?.chart?.result?.[0];
      const closes = r?.indicators?.quote?.[0]?.close;
      const prevCloses = r?.indicators?.adjclose?.[0]?.adjclose;
      if (!closes?.length) continue;
      const price = num(closes.at(-1));
      const prev = num(closes.length > 1 ? closes.at(-2) : prevCloses?.at(-1));
      if (price === null || prev === null) continue;
      out[e.code] = {
        price,
        prevClose: prev,
        open: null,
        high: null,
        low: null,
        volume: null,
        turnover: null,
        changePct: +(((price - prev) / prev) * 100).toFixed(2),
        source: 'yahoo',
      };
    } catch {
      // 单只失败就跳过，继续下一只
    }
  }
  if (!Object.keys(out).length) throw new Error('yahoo: no rows');
  return { data: out, tradingDate: null };
}
async function fetchQuotes(list) {
  const merged = {};
  let tradingDate = null;
  const attempts = [
    ['eastmoney', quotesEastmoney],
    ['tencent', quotesTencent],
    ['sina', quotesSina],
    ['yahoo', quotesYahoo],
  ];
  for (const [name, fn] of attempts) {
    const missing = list.filter((e) => !merged[e.code]);
    if (!missing.length) break;
    try {
      const got = await fn(missing);
      Object.assign(merged, got.data);
      if (!tradingDate && got.tradingDate) tradingDate = got.tradingDate;
      console.log(`quotes: ${name} ok, ${Object.keys(got.data).length} rows`);
    } catch (e) {
      console.log(`quotes: ${name} failed: ${e.message}`);
    }
  }
  return { quotes: merged, tradingDate };
}
// 用东财 K 线判断今天是不是交易日：最近一根日 K 日期 != 今天就跳过写历史。
async function lastTradingDay() {
  try {
    const json = await fetchJson(
      'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.158900&klt=101&fqt=1&beg=20261101&end=29991231&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55,f56,f57&lmt=5',
    );
    const klines = json?.data?.klines ?? [];
    const last = klines.at(-1)?.split(',')[0];
    return last ?? null;
  } catch {
    return null;
  }
}

// ---------- PCF ----------
// 上交所：COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C（基本）+
//         COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C（成分）
// 权重 = SUBSTITUTION_CASH_AMOUNT / NAVPERCU。来源：
// Jimmy-asks-AI/a-share-etf-pcf-metrics（MIT）scripts/pcf_lookthrough.py
const SSE_BASIC_SQL = 'COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C';
const SSE_COMP_SQL = 'COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C';
function parseJsonp(text) {
  const m = text.match(/^[^(]*\((.*)\)[^)]*$/s);
  return JSON.parse(m ? m[1] : text);
}
async function pcfSSE(e) {
  const referer = { Referer: 'https://www.sse.com.cn/disclosure/fund/etflist/' };
  const base = 'https://query.sse.com.cn/commonQuery.do?isPagination=false';
  const basic = parseJsonp(
    await fetchText(`${base}&FUNDID2=${e.code}&sqlId=${SSE_BASIC_SQL}&jsonCallBack=jsonpCallback1`, referer),
  );
  const comp = parseJsonp(
    await fetchText(`${base}&FUNDID2=${e.code}&sqlId=${SSE_COMP_SQL}&jsonCallBack=jsonpCallback1`, referer),
  );
  const b = basic?.result?.[0];
  const rows = comp?.result ?? [];
  if (!b || !rows.length) throw new Error('SSE PCF: no rows');
  const navPerCU = num(b.NAVPERCU);
  if (!navPerCU) throw new Error('SSE PCF: missing NAVPERCU');
  const top = rows
    .map((r) => ({
      code: String(r.INSTRUMENT_ID ?? '').trim(),
      name: String(r.INSTRUMENT_NAME ?? '').trim(),
      weightPct: num(r.SUBSTITUTION_CASH_AMOUNT) ? +((num(r.SUBSTITUTION_CASH_AMOUNT) / navPerCU) * 100).toFixed(4) : null,
      quantity: num(r.QUANTITY),
      flag: String(r.SUBSTITUTION_FLAG ?? ''),
    }))
    .filter((r) => r.code && r.weightPct !== null)
    .sort((a, b) => b.weightPct - a.weightPct)
    .slice(0, 20);
  return {
    source: 'sse_pcf',
    tradingDay: normDay(b.TRADING_DAY),
    navPerCU,
    navPerShare: num(b.NAV),
    componentCount: rows.length,
    top,
  };
}
// 深交所：ShowReport 拿下载文件名 → reportdocs 拿 XML。
// XML 里只有 ComponentShare（份数），权重需用成分股现价换算：
// weight = ComponentShare * 股价 / NAVperCU，股价用东财批量拉，拉不到就留空。
function xmlTag(text, tag) {
  const m = text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].trim() : '';
}
async function stockPrices(codes) {
  const out = {};
  // 首选新浪（本机与 GitHub Runner 上都可达，批量一次拉完）；
  // 不足一半时再用东财批量补。
  try {
    const q = codes.map((c) => `${marketOf(c)}${c}`).join(',');
    const text = await fetchText(`https://hq.sinajs.cn/list=${q}`, { Referer: 'https://finance.sina.com.cn' }, { timeoutMs: 10000, attempts: 1 });
    for (const line of text.split('\n')) {
      const m = line.match(/hq_str_\w+="([^"]*)"/);
      if (!m) continue;
      const parts = m[1].split(',');
      const code = line.match(/hq_str_(?:sh|sz)(\d+)/)?.[1];
      const price = num(parts[3]);
      if (code && price !== null) out[code] = price;
    }
  } catch {
    // 新浪失败就走东财兜底
  }
  if (Object.keys(out).length >= Math.ceil(codes.length / 2)) return out;
  const chunked = [];
  for (let i = 0; i < codes.length; i += 40) chunked.push(codes.slice(i, i + 40));
  for (const chunk of chunked) {
    try {
      const secids = chunk.map((c) => `${marketOf(c) === 'sh' ? 1 : 0}.${c}`).join(',');
      const json = await fetchJson(
        `https://push2.eastmoney.com/api/qt/stock/get?secid=${secids}&fields=f43,f57&invt=2&fltt=2`,
      );
      for (const d of json?.data ?? []) if (num(d.f43) !== null) out[d.f57] = num(d.f43);
    } catch {
      // 批量股价失败时权重留空，不阻塞整只 ETF
    }
  }
  return out;
}
async function pcfSZSE(e) {
  const referer = { Referer: 'https://www.szse.cn/disclosure/fund/currency/index.html' };
  // ShowReport 在 GitHub Runner 上常连不上（疑似屏蔽机房 IP），失败不直接判死，
  // 后面用 reportdocs 直链兜底。
  let rows = [];
  try {
    const payload = await fetchJson(
      `https://www.szse.cn/api/report/ShowReport/data?CATALOGID=sgshqd&loading=first&txtJCorDH=${e.code}`,
      referer,
    );
    rows = (Array.isArray(payload) ? payload : []).flatMap((b) => b?.data ?? []);
  } catch {
    rows = [];
  }
  const cell = String(rows[0]?.jjdm ?? '');
  // 首选：encode-open 给的 txt 直链，如 /files/text/etf/ETF15890020261124.txt
  const direct = cell.match(/encode-open=['"]([^'"]+\.txt)['"]/);
  let text = '';
  let sourceUrl = '';
  if (direct) {
    sourceUrl = `https://reportdocs.static.szse.cn${direct[1]}`;
    try {
      text = await fetchTextGBK(sourceUrl, referer);
    } catch (err) {
      text = '';
    }
  }
  if (!text || !text.includes('申购赎回清单')) {
    // 兜底：eft_download_new.html 里的 filename（分号分隔多个候选名）
    const m = cell.match(/filename=([^&"'\s]+)/);
    const names = m ? decodeURIComponent(m[1]).split(';').filter(Boolean) : [];
    let lastErr = '';
    for (const name of names) {
      for (const suffix of ['.txt', '.xml']) {
        const url = `https://reportdocs.static.szse.cn/files/text/ETFDown/${name}${suffix}`;
        try {
          const t = await fetchText(url, referer, { timeoutMs: 8000, attempts: 1 });
          if (t.includes('申购赎回清单') || t.includes('<Component')) {
            text = t;
            sourceUrl = url;
            break;
          }
        } catch (err) {
          lastErr = String(err.message ?? err);
        }
      }
      if (text) break;
    }
    // 最后兜底：按 ETF<code><YYYYMMDD>.txt 的固定格式直接拼 reportdocs 直链，
    // 今天及前 3 天各试一次（周末/节假日往前找最近交易日），绕开被屏蔽的
    // www.szse.cn 接口。
    for (let back = 0; back < 4 && !text; back++) {
      const d = new Date(`${cstToday()}T12:00:00+08:00`);
      d.setDate(d.getDate() - back);
      const ymd = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }).replaceAll('-', '');
      const url = `https://reportdocs.static.szse.cn/files/text/etf/ETF${e.code}${ymd}.txt`;
      try {
        const t = await fetchTextGBK(url, referer);
        if (t.includes('申购赎回清单')) {
          text = t;
          sourceUrl = url;
        }
      } catch {
        // 换前一天再试
      }
    }
    if (!text) throw new Error(`SZSE PCF: download failed: ${lastErr}`);
  }
  // txt 格式解析：标题行 ( 2026-11-24 )；基金份额净值；最小申购、赎回单位资产净值；
  // 组合行：6 位代码 + 简称 + 股份数量（带千分位逗号）+ 现金替代标志
  const tradingDay =
    normDay((text.match(/\(\s*(\d{4}-\d{2}-\d{2})\s*\)/) || [])[1] ?? '') ||
    normDay((text.match(/(\d{4}-\d{2}-\d{2})日\s*信息内容/) || [])[1] ?? '');
  const navPerShare = num((text.match(/基金份额净值：\s*([\d.]+)/) || [])[1]);
  const navPerCU = num((text.match(/最小申购、赎回单位资产净值：\s*([\d,.]+)/) || [])[1]);
  const comps = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{6})\s+(\S+)\s+([\d,]+)\s+(允许|禁止|必须|不允许)/);
    if (!m) continue;
    comps.push({ code: m[1], name: m[2], share: num(m[3]), flag: m[4] });
  }
  if (!comps.length) throw new Error('SZSE PCF: no components parsed from txt');
  let prices = {};
  if (navPerCU) prices = await stockPrices(comps.map((c) => c.code));
  const top = comps
    .map((c) => ({
      code: c.code,
      name: c.name,
      weightPct:
        navPerCU && prices[c.code] ? +((c.share * prices[c.code]) / navPerCU * 100).toFixed(4) : null,
      quantity: c.share,
      flag: c.flag,
    }))
    .sort((a, b) => (b.weightPct ?? 0) - (a.weightPct ?? 0) || b.quantity - a.quantity)
    .slice(0, 20);
  return { source: 'szse_pcf_txt', tradingDay, navPerCU: navPerCU ?? null, navPerShare: navPerShare ?? null, componentCount: comps.length, top, sourceUrl };
}
async function fetchPCF(e) {
  try {
    const r = e.exchange === 'SSE' ? await pcfSSE(e) : await pcfSZSE(e);
    return { ...r, status: 'ok' };
  } catch (err) {
    return { source: e.exchange === 'SSE' ? 'sse_pcf' : 'szse_pcf', status: 'failed', error: String(err.message ?? err) };
  }
}

// ---------- 主流程 ----------
async function main() {
  const today = cstToday();
  if (cstWeekday(today) === 0 || cstWeekday(today) === 6) {
    console.log(`${today} is weekend (CST), skip.`);
    return;
  }
  const { quotes, tradingDate } = await fetchQuotes(etfs);
  // 行情所属的交易日优先用行情自带日期（开盘前跑时，最新价还是上一交易日的，
  // 不能记成今天）。拿不到时才用今天。
  const date = tradingDate ?? today;
  console.log(`trading date: ${date} (today ${today})`);
  const quoteCodes = Object.keys(quotes);
  console.log(`quotes: ${quoteCodes.length}/${etfs.length} ok`);
  if (!quoteCodes.length) {
    console.error('FATAL: no quotes from any source, aborting without writing data.');
    process.exit(1);
  }
  const missing = etfs.filter((e) => !quotes[e.code]).map((e) => e.code);
  if (missing.length) console.log(`quotes missing (kept from previous day if any): ${missing.join(',')}`);

  const lastDay = await lastTradingDay();
  const isTradingDay = lastDay ? lastDay === date : true;
  console.log(`last trading day from kline: ${lastDay ?? 'unknown'}, today ${date}, isTradingDay=${isTradingDay}`);

  // PCF：18 只串行拉，交易所接口有频率敏感，失败单只记 failed 不阻塞其它。
  const pcfStatus = {};
  const pcfDayDir = join(DATA_DIR, 'pcf', date);
  mkdirSync(pcfDayDir, { recursive: true });
  const prevDates = existsSync(join(DATA_DIR, 'pcf'))
    ? readdirSync(join(DATA_DIR, 'pcf')).filter((d) => d < date).sort()
    : [];
  const prevDate = prevDates.at(-1);
  for (const e of etfs) {
    const r = await fetchPCF(e);
    pcfStatus[e.code] = {
      status: r.status,
      source: r.source,
      tradingDay: r.tradingDay ?? null,
      componentCount: r.componentCount ?? null,
      navPerShare: r.navPerShare ?? null,
      error: r.error ?? null,
    };
    if (r.status === 'ok') {
      // 持仓变动：和上一个有快照的交易日比 Top20
      let changes = { added: [], removed: [], weightChanged: [] };
      const prevFile = prevDate ? join(DATA_DIR, 'pcf', prevDate, `${e.code}.json`) : null;
      if (prevFile && existsSync(prevFile)) {
        try {
          const prev = JSON.parse(readFileSync(prevFile, 'utf8'));
          const prevMap = new Map((prev.top ?? []).map((t) => [t.code, t]));
          const curMap = new Map(r.top.map((t) => [t.code, t]));
          for (const [code, cur] of curMap) {
            if (!prevMap.has(code)) changes.added.push({ code, name: cur.name, weightPct: cur.weightPct });
            else if (cur.weightPct !== null && prevMap.get(code).weightPct !== null) {
              const d = +(cur.weightPct - prevMap.get(code).weightPct).toFixed(4);
              if (Math.abs(d) >= 0.5) changes.weightChanged.push({ code, name: cur.name, from: prevMap.get(code).weightPct, to: cur.weightPct, delta: d });
            }
          }
          for (const [code, p] of prevMap) if (!curMap.has(code)) changes.removed.push({ code, name: p.name, weightPct: p.weightPct });
        } catch {
          // 上一日快照解析失败就跳过变动计算
        }
      }
      writeFileSync(
        join(pcfDayDir, `${e.code}.json`),
        JSON.stringify({ date, etf: e.code, name: e.name, ...r, changes }, null, 2),
      );
      console.log(`pcf ${e.code}: ok, ${r.componentCount} components, tradingDay ${r.tradingDay}`);
    } else {
      console.log(`pcf ${e.code}: FAILED ${r.error}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  const latest = {
    date,
    fetchedAt: new Date().toISOString(),
    source: 'eastmoney/tencent/sina/yahoo (first success per ETF)',
    etfs: quotes,
    pcfStatus,
    missingQuotes: missing,
  };
  writeFileSync(join(DATA_DIR, 'latest.json'), JSON.stringify(latest, null, 2));

  if (isTradingDay) {
    const histPath = join(DATA_DIR, 'history.json');
    const hist = JSON.parse(readFileSync(histPath, 'utf8'));
    const idx = hist.days.findIndex((d) => d.date === date);
    const day = { date, etfs: quotes, pcfStatus };
    if (idx >= 0) hist.days[idx] = day;
    else hist.days.push(day);
    hist.days = hist.days.slice(-365);
    writeFileSync(histPath, JSON.stringify(hist, null, 2));
    console.log(`history: ${hist.days.length} days`);
  } else {
    console.log('Not a trading day per kline, latest.json updated but history not appended.');
  }
  console.log('done.');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
