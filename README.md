# 首批18只主动ETF追踪站

长期跟踪中国首批18只主动ETF：**每日涨跌 + 基金份额 + PCF持仓变动**。Astro 静态站，GitHub Actions 每个交易日收盘后跑一次数据，自动提交并部署到 GitHub Pages。

> 先说清一个数字：用户最初说的是“16只”，核实后是 **18只**。
> “16只”出自2026-11-02的报道，当时18只里已有16只完成募集，只剩建信、鹏华还在发行途中。
> 2026-11-23，18只已全部在沪深交易所上市（上交所9只、深交所9只），没有增减、没有更名。
> 本站按18只建。另外修正了一处代码：永赢景气均衡的场内交易代码是 **581060**，不是581063（581063是另一套代码）。

## 这18只是谁

| 交易所 | 基金 |
| --- | --- |
| 上交所（9只） | 易方达品质均衡 581050、华夏质量甄选 581030、永赢景气均衡 581060、摩根大盘成长 581000、华泰柏瑞价值精选 581090、汇添富均衡策略智选 581010、华安均衡慧选 581020、招商价值智选 581080、平安红利景气 581070 |
| 深交所（9只） | 南方均衡配置 158900、富国价值优选量化选股 158901、大成红利智选 158902、鹏华价值臻选 158903、工银瑞信红利 158905、华宝均衡精选 158906、国泰鑫汇均衡收益 158907、天弘均衡量化选股 158908、建信均衡优选 158909 |

完整名单（含管理人、风格、业绩比较基准、上市前仓位）见 [`src/data/etfs.json`](src/data/etfs.json)。
上市前基线（截至2026-11-16，来自各基金上市交易公告书）：18只平均股票仓位 **56.71%**，中位数59.62%，净值0.9687–1.0159元；最高招商91.33%，最低国泰29.48%。

## 数据口径（重要）

- **每日涨跌**：场内收盘价相对前一交易日收盘价。不是相对1元发行价；“上市以来”相对本站记录的首个交易日（2026-11-23）收盘价。
- **基金份额**：总份额（亿份）及相对上一份份额记录的增减。**份额增是申购、减是赎回，是资金进出的直接口径**，
  与 PCF 持仓变动互补。上交所按日归档（当日数据一般收盘后才出，查不到就往前找最近 5 天）；
  深交所只提供当前快照（T 日晚为预估值、T+1 早为确认值）。两所份额的日期可能比行情晚一天，以份额自身日期为准。
- **持仓**：来自交易所每日 PCF（申购赎回清单），每个交易日开市前披露、基于前一交易日日终组合。
  **PCF 是申赎篮子估算，不等同基金精确持仓**；完整持仓以季报/半年报/年报为准。不要拿 PCF 单只权重直接“抄作业”。
- **PCF 权重**：上交所 = 现金替代金额 / 每申购赎回单位净值；深交所 = 成分股份数 × 成分股现价 / 每单位净值（股价拉不到时权重留空，只保留份数）。

## 数据源

全部免费、无需 key，抓取脚本按顺序兜底，全部失败时以非零退出、让 Action 变红，不静默写假数据：

- 行情：东方财富 push2 → 腾讯 `qt.gtimg.cn` → 新浪 `hq.sinajs.cn` → Yahoo Finance
- PCF：上交所 `query.sse.com.cn/commonQuery.do`（sqlId `COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C` / `..._COMPONENT_C`）；
  深交所 `www.szse.cn/api/report/ShowReport/data`（CATALOGID=`sgshqd`）+ `reportdocs.static.szse.cn` 的 XML。
  PCF 的接口形态参考了 [Jimmy-asks-AI/a-share-etf-pcf-metrics](https://github.com/Jimmy-asks-AI/a-share-etf-pcf-metrics)（MIT）。
- 份额：上交所 `query.sse.com.cn/commonQuery.do`（sqlId `COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L`，`STAT_DATE` 按日归档，`TOT_VOL` 单位万份）；
  深交所 `fund.szse.cn/api/report/ShowReport/data`（CATALOGID=`1000_lf`，`selectJjlb=ETF`，当前快照，`dqgm` 单位万份）。
  端点形态参考了 [simonlin1212/a-stock-data](https://github.com/simonlin1212/a-stock-data) §4.7 `etf_shares()`（Apache-2.0）。

已验证（2026-11-24 本机实测）：`npm run fetch` 全程约 45 秒，18 只行情 + 18 只 PCF 全部成功。
行情走了新浪兜底（东财 push2 在本机返回 502、腾讯超时；GitHub Runner 上东财通常可达）。
深交所 PCF 走 `reportdocs.static.szse.cn/files/text/etf/ETF<code><日期>.txt`（GBK 文本），上交所走 `query.sse.com.cn`。
Yahoo 对这批新 ETF 暂无数据，只作最后兜底。节假日用东财 K 线判断“今天不是交易日”，只更新 `latest.json`，不往历史里追加。

## 本地跑

```bash
npm install
npm run fetch   # 拉当日行情 + PCF，写 public/data/
npm run dev     # 本地预览
npm run build   # 构建到 dist/
```

## 部署到 GitHub

1. 新建公开仓库，名字建议就叫 `active-etf-tracker`，把本目录推上去。
2. 仓库 Settings → Pages → Build and deployment → Source 选 **GitHub Actions**。
3. `astro.config.mjs` 里的 `site` / `base` 按你的仓库改：
   - 仓库名是 `active-etf-tracker`：不用改，`site: https://<用户名>.github.io/active-etf-tracker/`，`base: '/active-etf-tracker/'`。
   - 其它仓库名：把两处都改成对应名字；如果是用户站（`<用户名>.github.io`），`base` 改成 `'/'`。
4. Actions 页点 **Daily active ETF data + deploy** → Run workflow 手动跑一次，确认数据和页面都出来。
5. 之后每天北京时间16:00（UTC 08:00，周一至周五）自动跑：拉数据 → 提交 `public/data/` → 构建 → 部署 Pages。

## 按持仓股票看（重叠最高的 5 只）

`/stocks`：2026-11-24 PCF Top20 快照里 18 只基金共出现 174 只不同股票，按持有基金数取前 5 只——
美的集团（10 只）、宁德时代（10 只）、北方华创（7 只）、招商银行（6 只）、中际旭创（6 只）。
每只列出持有它的基金与占各基金 PCF 篮子的权重，并用龟龟方法（V5.2.2，先判断经营、再判断价格，六年现金回本）做一遍分析，
报告原文在 `analysis/`（银行不适用现金回本法，招商银行改用 ROE / 分红 / 资产质量 / 资本框架）。
5 只中只有宁德时代在赛博龟龟陪审团站内有收录报告（页面挂了外链），其余 4 只该站没有页面。
结论（研究截止日 2026-11-24，股价为 11-23 收盘）：美的 / 宁德 / 北方华创 / 中际旭创价格条件均未通过，
只有招商银行通过（PB 0.92、TTM 股息率 4.66%，安全垫中等）。

## 数据文件

- `public/data/latest.json`：最新一天18只的价、涨跌幅、基金份额与 PCF 状态
- `public/data/history.json`：每日快照历史（近365天，含当日份额）
- `public/data/pcf/<日期>/<代码>.json`：每只每天的 PCF Top20 与相对上一日的变动（新增 / 剔除 / 权重变化≥0.5pp）
- `src/data/etfs.json`：18只名单；`src/data/baseline.json`：上市前基线

本站仅做信息整理，不构成投资建议。
