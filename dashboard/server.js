// Read-only dashboard for local pipeline files. It never submits trades.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const SIG = path.join(ROOT, 'data', 'signals');
const PORT = Number(process.env.DASHBOARD_PORT || 5300);
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const GLITCH_MIN = -1.05, GLITCH_MAX = 3.0;
const PAPER_TRADES_PATH = path.join(SIG, 'executor_paper.jsonl');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function readLines(p, maxLines) {
  try {
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (!raw) return [];
    const lines = raw.split('\n');
    return maxLines ? lines.slice(-maxLines) : lines;
  } catch { return []; }
}
function parseJsonl(p, maxLines) {
  return readLines(p, maxLines)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}
function mtimeAgeS(p) {
  try { return (Date.now() - fs.statSync(p).mtimeMs) / 1000; } catch { return null; }
}
function assignBatch(e) {
  return e.batch === undefined ? 1 : Number(e.batch);
}
function etagSend(req, res, data) {
  const body = JSON.stringify(data);
  const etag = '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 16) + '"';
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.set('ETag', etag);
  res.set('Content-Type', 'application/json');
  res.send(body);
}

// TTL caches for expensive scans
const cache = {};
function cached(key, ttlMs, compute) {
  const now = Date.now();
  const hit = cache[key];
  if (hit && now - hit.t < ttlMs) return hit.v;
  const v = compute();
  cache[key] = { v, t: now };
  return v;
}
async function cachedAsync(key, ttlMs, compute) {
  const now = Date.now();
  const hit = cache[key];
  if (hit && now - hit.t < ttlMs) return hit.v;
  const v = await compute();
  cache[key] = { v, t: now };
  return v;
}

// ---------- data loaders ----------

function loadExits() {
  return cached('exits', 15_000, () =>
    parseJsonl(path.join(SIG, 'shadow_trades.jsonl'))
      .filter((e) => e.event === 'exit' && !e.invalid)
      .map((e) => ({ ...e, batch: assignBatch(e) }))
  );
}
function loadEntries() {
  return cached('entries', 15_000, () =>
    parseJsonl(path.join(SIG, 'shadow_trades.jsonl'))
      .filter((e) => e.event === 'entry')
  );
}
function shadowState() {
  return readJsonSafe(path.join(SIG, 'shadow_state.json'), {});
}
function batchState() {
  return readJsonSafe(path.join(SIG, 'batch_state.json'), {});
}
function changeLog() {
  return readJsonSafe(path.join(SIG, 'config_change_log.json'), []);
}
function activeBatch() { return batchState().batch || 1; }

function cleanExits(batch) {
  return loadExits().filter(
    (e) => (batch === undefined || e.batch === batch) &&
      e.return > GLITCH_MIN && e.return < GLITCH_MAX
  );
}
function statsOf(exits) {
  const n = exits.length;
  if (!n) return { n: 0, mean_ret: 0, win_rate: 0, stop_rate: 0, reasons: {} };
  const wins = exits.filter((e) => e.return > 0).length;
  const stops = exits.filter((e) => e.reason === 'sl').length;
  const reasons = {};
  exits.forEach((e) => { reasons[e.reason] = (reasons[e.reason] || 0) + 1; });
  return {
    n,
    mean_ret: exits.reduce((a, e) => a + e.return, 0) / n,
    win_rate: wins / n,
    stop_rate: stops / n,
    reasons,
  };
}

// Display-only paper wallet model. Configure it locally in .env.
const WALLET_START_SOL = Number(process.env.PAPER_WALLET_START_SOL || 0.1);
const STAKE_SOL = Number(process.env.DUST_STAKE_SOL || 0.01);

function perfSeries(batch) {
  const exits = cleanExits(batch).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  let balance = WALLET_START_SOL, wins = 0;
  const points = exits.map((e, i) => {
    balance += STAKE_SOL * e.return;
    if (e.return > 0) wins++;
    return {
      i: i + 1,
      ts: e.ts,
      mint: e.mint,
      ret: e.return,
      balance: Math.round(balance * 10000) / 10000,
      wr: Math.round((wins / (i + 1)) * 1000) / 10,
    };
  });
  return { points, final_balance: balance, start_balance: WALLET_START_SOL, stake_sol: STAKE_SOL };
}

// ---------- endpoints ----------

app.get('/api/stats', (req, res) => {
  const st = shadowState();
  const b = activeBatch();
  const today = new Date().toISOString().slice(0, 10);
  const all = cleanExits();
  const todayExits = all.filter((e) => (e.ts || '').slice(0, 10) === today);
  let lastEv = null;
  try {
    const trigReport = fs.readFileSync(path.join(SIG, 'reports', 'trigger_report.txt'), 'utf8')
      .match(/EV\/trade=\s*([+-]\d+\.\d+)%/g) || [];
    if (trigReport.length) lastEv = trigReport[trigReport.length - 1].match(/([+-]\d+\.\d+)/)[1];
  } catch {}
  etagSend(req, res, {
    batch: b,
    config_hash: batchState().config_hash,
    watching: Object.keys(st.watchlist || {}).length,
    open: Object.keys(st.positions || {}).length,
    closed_today: todayExits.length,
    closed_all: all.length,
    active_batch_stats: statsOf(cleanExits(b)),
    backtest_ev: lastEv,
    health: healthAll(),
  });
});

app.get('/api/shadow/live', (req, res) => {
  const st = shadowState();
  const now = Date.now();
  const positions = Object.values(st.positions || {}).map((p) => ({
    mint: p.mint, pool: p.pool, entry: p.entry, trigger_price: p.trigger_price,
    peak: p.peak, liq: p.liq, held_s: Math.max(0, Math.round((now - p.t_entry * 1000) / 1000)),
    last_price: p.samples && p.samples.length ? p.samples[p.samples.length - 1][1] : null,
    batch: activeBatch(),
  }));
  const watchlist = Object.values(st.watchlist || {}).map((w) => ({
    mint: w.mint, pool: w.pool, liq: w.liq, buyers: w.buyers, buys: w.buys, sells: w.sells,
    t_listed: w.t_listed, samples: w.samples ? w.samples.length : 0,
    last_price: w.samples && w.samples.length ? w.samples[w.samples.length - 1][1] : null,
  }));
  etagSend(req, res, { positions, watchlist });
});

app.get('/api/shadow/trades', (req, res) => {
  const batch = req.query.batch === undefined || req.query.batch === '' ? undefined : Number(req.query.batch);
  const reason = req.query.reason || '';
  const outcome = req.query.outcome || '';
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  let exits = cleanExits(batch).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  if (reason) exits = exits.filter((e) => e.reason === reason);
  if (outcome === 'win') exits = exits.filter((e) => e.return > 0);
  if (outcome === 'loss') exits = exits.filter((e) => e.return <= 0);
  // join with the most recent entry event per mint for full metadata
  const entryByMint = {};
  loadEntries().forEach((e) => { entryByMint[e.mint] = e; });
  const rows = exits.slice(0, limit).map((e) => {
    const en = entryByMint[e.mint] || {};
    return {
      ts: e.ts, batch: e.batch, mint: e.mint, pool: e.pool,
      reason: e.reason, exit_price: e.exit_price, entry_modeled: e.entry_modeled,
      peak_price: e.peak_price, return: e.return, held_s: e.held_s,
      peak_multiple: e.peak_multiple,
      // entry-side metadata (expanded view)
      trigger_price: en.trigger_price, mom_ref: en.mom_ref, t_listed: en.t_listed,
      liq: en.liq, config_hash: e.config_hash || en.config_hash,
    };
  });
  etagSend(req, res, { count: exits.length, rows });
});

app.get('/api/batches', (req, res) => {
  const batches = {};
  loadExits().forEach((e) => {
    if (e.return <= GLITCH_MIN || e.return >= GLITCH_MAX) return;
    (batches[e.batch] = batches[e.batch] || []).push(e);
  });
  const agg = Object.keys(batches).map(Number).sort().map((b) => ({
    batch: b, stats: statsOf(batches[b]),
    perf: perfSeries(b).points.slice(-1)[0] || null,
  }));
  etagSend(req, res, {
    active_batch: activeBatch(),
    batch_state: batchState(),
    change_log: changeLog(),
    batches: agg,
  });
});

app.get('/api/batches/perf', (req, res) => {
  const b = req.query.batch === undefined ? activeBatch() : Number(req.query.batch);
  etagSend(req, res, { batch: b, ...perfSeries(b) });
});

app.get('/api/research', (req, res) => {
  const data = cached('research', 600_000, () => {
    // trigger report parse (line-based; anchor on the MOMENTUM TRIGGER section)
    let trigger = null;
    let baseline_ev = null;
    try {
      const txt = fs.readFileSync(path.join(SIG, 'reports', 'trigger_report.txt'), 'utf8');
      const baseM = txt.match(/P\(tp50 first\)=([\d.]+)%\s+P\(sl30 first\)=([\d.]+)%\s+P\(timeout\)=([\d.]+)%\s+EV\/trade=([+-][\d.]+)%/);
      if (baseM) baseline_ev = Number(baseM[4]);
      const idx = txt.indexOf('MOMENTUM TRIGGER');
      if (idx >= 0) {
        const trig = txt.slice(idx);
        const firedM = trig.match(/fired on (\d+)\/(\d+) gated tokens/);
        const lineM = trig.match(/P\(tp50 first\)=([\d.]+)%\s+P\(sl30 first\)=([\d.]+)%\s+P\(timeout\)=([\d.]+)%\s+EV\/trade=([+-][\d.]+)%/);
        const medM = trig.match(/median 15m return from trigger: ([+-][\d.]+)%/);
        if (firedM && lineM) {
          trigger = {
            fired: Number(firedM[1]), gated: Number(firedM[2]),
            p_tp: Number(lineM[1]), p_sl: Number(lineM[2]), p_timeout: Number(lineM[3]),
            ev: Number(lineM[4]), median_15m: medM ? Number(medM[1]) : null,
          };
        }
      }
    } catch {}
    // outcome histogram from scored+candles (10-min TTL)
    const scored = {};
    parseJsonl(path.join(SIG, 'scored_v2.jsonl')).forEach((r) => { scored[r.mint] = r; });
    const buckets = {
      'hard SL -30%': 0, '-30..-15%': 0, '-15..0% (mild loss)': 0,
      '0..+10%': 0, '+10..25%': 0, '+25..50%': 0, '+50% (TP)': 0,
    };
    let n = 0;
    parseJsonl(path.join(SIG, 'candles_v2.jsonl')).forEach((p) => {
      const r = scored[p.mint];
      if (!r) return;
      const liq = r.liq || 0;
      const bb = (r.buys_h1 || 0) / Math.max(1, r.buyers_h1 || 0);
      const sp = (r.sells_h1 || 0) / Math.max(1, r.buys_h1 || 0);
      if (!(liq >= 15000 && bb <= 3 && sp <= 0.3)) return;
      const candles = (p.candles || []).filter((c) => c.length >= 6);
      if (candles.length < 12) return;
      let t = null;
      for (let i = 5; i < candles.length - 2; i++) {
        if (candles[i][4] / candles[i - 5][4] - 1 >= 0.15) { t = i; break; }
      }
      if (t === null || t > candles.length - 15) return;
      const entry = candles[t][4] * 1.03;
      let res = 'timeout', ret = null;
      for (const c of candles.slice(t + 1, t + 16)) {
        if (c[3] <= entry * 0.7) { res = 'sl'; break; }
        if (c[2] >= entry * 1.5) { res = 'tp'; break; }
      }
      if (res === 'tp') ret = 0.5;
      else if (res === 'sl') ret = -0.30;
      else ret = candles[Math.min(t + 15, candles.length - 1)][4] / entry - 1;
      n++;
      if (ret === -0.30) buckets['hard SL -30%']++;
      else if (ret <= -0.15) buckets['-30..-15%']++;
      else if (ret < 0) buckets['-15..0% (mild loss)']++;
      else if (ret < 0.10) buckets['0..+10%']++;
      else if (ret < 0.25) buckets['+10..25%']++;
      else if (ret < 0.50) buckets['+25..50%']++;
      else buckets['+50% (TP)']++;
    });
    return {
      trigger,
      ev_convergence: [],
      histogram: { n, buckets },
    };
  });
  etagSend(req, res, data);
});

function healthAll() {
  // per-process staleness thresholds: recorder/shadow write every 60-90s;
  // supervisor sleeps ~5.5h between cycles, only writes during its ~30min cycle
  const checks = [
    ['recorder', path.join(SIG, 'recorder_v2_state.json'), 300],
    ['shadow', path.join(SIG, 'shadow_state.json'), 300],
    ['supervisor', path.join(SIG, 'pipeline_loop.log'), 25200],
  ];
  const out = {};
  for (const [name, p, maxAge] of checks) {
    const age = mtimeAgeS(p);
    out[name] = age === null ? { status: 'dead', age_s: null }
      : age > maxAge ? { status: 'stale', age_s: Math.round(age) }
      : { status: 'fresh', age_s: Math.round(age) };
  }
  return out;
}

app.get('/api/pipeline', (req, res) => {
  const rec = readJsonSafe(path.join(SIG, 'recorder_v2_state.json'), {});
  const zombies = readJsonSafe(path.join(SIG, 'no_candles.json'), {});
  const scoredCount = cached('scored_count', 60_000, () =>
    readLines(path.join(SIG, 'scored_v2.jsonl')).length);
  let lastCycle = null;
  try {
    const log = fs.readFileSync(path.join(SIG, 'pipeline_loop.log'), 'utf8');
    const m = log.match(/cycle done in (\d+) min, sleeping (\d+) min/g);
    if (m && m.length) lastCycle = m[m.length - 1];
  } catch {}
  etagSend(req, res, {
    recorder: {
      events_logged: rec.events_logged || 0,
      pf_calls: rec.pf_calls || 0, gt_calls: rec.gt_calls || 0,
      rpc_calls: rec.rpc_calls || 0,
      pf_backoff_s_left: Math.max(0, Math.round((rec.pf_backoff_until || 0) - Date.now() / 1000)),
      watch: Object.keys(rec.watchlist || {}).length,
      enrich_queue: (rec.enrich_queue || []).length,
    },
    supervisor: { last_cycle: lastCycle, reports_age_s: mtimeAgeS(path.join(SIG, 'reports', 'trigger_report.txt')) },
    scorer: { scored_rows: scoredCount, zombie_blacklist: Object.keys(zombies).length },
    health: healthAll(),
  });
});

// Compare executor quote-based entries with the Python shadow model.
app.get('/api/executor/stats', (req, res) => {
  const batch = req.query.batch === undefined ? activeBatch() : Number(req.query.batch);
  const events = parseJsonl(PAPER_TRADES_PATH).map(assignBatch);
  const exits = events.filter((e) => e.event === 'exit' && !e.invalid && e.batch === batch && e.return > GLITCH_MIN && e.return < GLITCH_MAX);
  const entries = events.filter((e) => e.event === 'entry' && e.batch === batch);
  const probed = entries.filter((e) => e.fill_probe);
  const okProbes = probed.filter((e) => e.fill_probe.status === 'ok');
  const slips = okProbes.map((e) => e.fill_probe.slip_vs_trigger).filter((x) => typeof x === 'number' && x > -0.95 && x < 3);
  const quoteEntries = entries.filter((e) => e.entry_source === 'quote');
  const shadowStats = statsOf(cleanExits(batch));
  const stats = exits.length ? statsOf(exits) : { n: 0, mean_ret: 0, win_rate: 0, stop_rate: 0, reasons: {} };
  etagSend(req, res, {
    batch,
    executor: {
      stats,
      entries: entries.length,
      quote_filled: quoteEntries.length,
      probe_fail_rate: probed.length ? 1 - okProbes.length / probed.length : null,
      mean_probe_slip: slips.length ? slips.reduce((a, b) => a + b, 0) / slips.length : null,
      median_probe_slip: slips.length ? slips.slice().sort((a, b) => a - b)[Math.floor(slips.length / 2)] : null,
    },
    shadow: shadowStats,
    divergence: exits.length ? {
      mean_gap_pp: 100 * (shadowStats.mean_ret - stats.mean_ret),
      wr_gap_pp: 100 * (shadowStats.win_rate - stats.win_rate),
      stop_gap_pp: 100 * (shadowStats.stop_rate - stats.stop_rate),
    } : null,
  });
});

// Live positions come from the executor's own state file.
app.get('/api/executor/live', (req, res) => {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(path.join(SIG, 'executor_state.json'), 'utf8')); } catch {}
  const positions = Object.values(st.positions || {}).map((p) => ({
    mint: p.mint, pool: p.pool, entry: p.entry, trigger_price: p.trigger_price,
    peak: p.peak, liq: p.liq, entry_batch: p.entry_batch,
    sell_pending: !!p.sell_pending,
    invalid_reason: p.invalid_reason || null,
    held_s: Math.max(0, Math.round((Date.now() / 1000 - p.t_entry))),
  }));
  etagSend(req, res, { positions, count: positions.length });
});

// Read the configured wallet's SOL balance directly from RPC.
app.get('/api/wallet', async (req, res) => {
  const data = await cachedAsync('wallet', 30_000, async () => {
    try {
      const rpc = process.env.HELIUS_RPC_URL;
      const pub = process.env.WALLET_PUBKEY;
      if (!rpc || !pub) return { configured: false };
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [pub, { commitment: 'confirmed' }] }),
      });
      const d = await r.json();
      return { configured: true, pubkey: pub, sol: d.result.value / 1e9 };
    } catch (e) {
      return { configured: false, error: String(e).slice(0, 120) };
    }
  });
  etagSend(req, res, data);
});

// ---------- curve paper stream ----------

app.get('/api/curve', (req, res) => {
  const events = parseJsonl(path.join(SIG, 'curve_paper.jsonl'));
  const pf = readJsonSafe(path.join(SIG, 'curve_positions.json'), { positions: {}, closed: [] });
  const feedState = readJsonSafe(path.join(SIG, 'curve_state.json'), { watchlist: {} });

  const aborts = {};
  for (const e of events) {
    if (e.kind === 'curve_entry_booked') continue;
    if (e.kind && e.kind.startsWith('curve_')) aborts[e.kind] = (aborts[e.kind] || 0) + 1;
  }
  const booked = events.filter((e) => e.kind === 'curve_entry_booked');
  const closedAll = (pf.closed || []).slice().reverse();
  const real = closedAll.filter((p) => p.exit_reason !== 'test' && !p.shadow);
  const shadows = closedAll.filter((p) => p.exit_reason !== 'test' && p.shadow);
  const n = real.length;
  const wins = real.filter((p) => (p.pnl_sol || 0) > 0).length;
  const pnl = real.reduce((a, p) => a + (p.pnl_sol || 0), 0);
  const shN = shadows.length;
  const shWins = shadows.filter((p) => (p.pnl_sol || 0) > 0).length;
  const shPnl = shadows.reduce((a, p) => a + (p.pnl_sol || 0), 0);
  const open = Object.values(pf.positions || {}).map((p) => ({
    mint: p.mint, t_entry_us: p.t_entry_us, size_sol: p.size_sol,
    tokens_raw: p.tokens_raw, entry_eff_price: p.entry_eff_price,
    peak_price: p.peak_price, moonbag_done: p.moonbag_done,
    sol_realized: p.sol_realized,
  }));
  const closedRows = closedAll.slice(0, 100).map((p) => ({
    mint: p.mint, exit_reason: p.exit_reason, pnl_sol: p.pnl_sol,
    size_sol: p.size_sol, moonbag_done: p.moonbag_done,
    closed_at: p.closed_at, test: p.exit_reason === 'test', shadow: !!p.shadow,
    shadow_reasons: p.shadow_reasons || [],
  }));
  const recent = events.slice(-40).reverse().map((e) => ({
    ts: e.ts, kind: e.kind, mint: (e.mint || '').slice(0, 10),
    mom: e.mom, dev_pct: e.dev_pct, pnl_sol: e.pnl_sol,
  }));
  etagSend(req, res, {
    open,
    closed: closedRows,
    recent,
    stats: { n, wr: n ? wins / n : null, pnl_sol: pnl, open: open.length, test_rows: closedAll.length - n },
    funnel: { booked: booked.length, aborts },
    feed: {
      watch: Object.keys(feedState.watchlist || {}).length,
      saved_at: feedState.saved_at || null,
      log_age_s: mtimeAgeS(path.join(SIG, 'curve_feed.jsonl')),
    },
  });
});

app.get('/api/health', (req, res) => etagSend(req, res, healthAll()));

app.listen(PORT, HOST, () => {
  console.log(`[dashboard] listening on http://${HOST}:${PORT}`);
  console.log(`[dashboard] read-only file mode, active batch: ${activeBatch()}`);
});
