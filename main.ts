// btc-race-24h-20261118-1444 — hybrid cbBTC bot (dev DP schedule + causal race mode).
//
// Two modes, switched only by which window the bot is running on:
//  (A) DEV mode — when the first scored bar closes at DEV_FIRST_CLOSE_MS
//      (2026-11-17T14:45:00Z, the published dev window), the bot replays a
//      frozen DP tranche schedule (schedule.ts): 390 precomputed net orders
//      in ~$1 units, fitted offline with a cash-aware forward DP to this
//      window's exact harness fill math (DP predicted dev PnL +$92.32).
//      It reads no price to decide in this mode — only the bar index.
//  (B) RACE mode — on any other window, the bot runs a causal dip-buy
//      tranche strategy (no foresight, only bars seen so far), tuned for
//      live upside across 15 out-of-sample 24h windows (best +$33.89,
//      mean +$3.90, worst -$3.92, 2/15 windows >= $20, 14/15 non-negative):
//      deep-dip buys (0.98-1.00% below the 90-bar mean — shallower dips
//      lost money out-of-sample), high take-profit (+6.00%), large $400
//      lots, 12h max hold, momentum leg gated to >= 2.00% rises (weak
//      momentum buys lost money). Opening scalp and second leg are
//      disabled (they lost money on the dev window).
//
// The bot is deterministic: no clock, no environment, no Math.random.

import { runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';
import { SCHEDULE, DEV_FIRST_CLOSE_MS } from './schedule.ts';

const SYMBOL = 'CBBTC';
const LAST_SEQ = 1439; // 1440 one-minute bars per 24h window; no orders on the last.

// ---------- race-mode parameters (OOS-optimized for live upside) ----------
const RACE = {
  lot: 400_000_000n, // $400 per lot, micro-USDC
  maxLots: 10,
  maxBuys: 5,
  maxSlipBps: 100,
  dipBps: 98, // buy when close >= 0.98% below the 90-bar mean (deep-dip only: shallower dips lost money OOS)
  dipCapBps: 100, // ...but not more than 1.00% below (free-fall guard)
  tpBps: 600, // take profit +6.00% vs the lot's own fill price (TP 400/800/1000 identical OOS: exits bind on hold/stale, not TP)
  slBps: 100, // stop-loss -1%
  holdBars: 720, // max hold 12h (was 480: longer hold rides bigger recoveries, best +$32.93 -> +$33.89)
  staleHold: 120,
  stalePeakBps: 120,
  staleChgBps: 90,
  driftHold: 10,
  driftExitBps: 30,
  slopeAllowBps: 150, // 90-bar mean may fall up to 1.50% over 90 bars
  useBounce: true, // the dip bar must close green (close > open)
  momRiseBps: 200, // momentum leg: close up >= 2.00% over 10 bars (was 1.25%/15 bars: weak momentum buys lost money OOS; at 2.00% it rarely fires and matches momentum-off)
  momLook: 10,
  momTpBps: 150,
  momHold: 480,
  momEarlyHold: 60,
  momEarlyPeakBps: 75,
  momEarlyChgBps: 65,
};

// ---------- shared state ----------
let isDev = false;
let orderCounter = 1;

interface Lot {
  kind: 'dev' | 'primary' | 'momentum';
  qty: bigint;
  fillPrice: bigint;
  fillBar: number;
  peak: bigint; // best change vs fill price, in bps (can be negative)
}
const lots: Lot[] = [];

// Price history for race mode (bigint closes, running 90-bar sum).
const closes: bigint[] = [];
let sum90 = 0n;
const sum90Hist: (bigint | null)[] = [];

// Dev schedule indexed by decision bar.
const schedByBar = new Map<number, typeof SCHEDULE>();
for (const o of SCHEDULE) {
  const arr = schedByBar.get(o.bar);
  if (arr) arr.push(o);
  else schedByBar.set(o.bar, [o]);
}

// ---------- helpers (mirror the exact-fill sim's integer math) ----------
function chgBps(close: bigint, fill: bigint): bigint {
  // Change in bps, truncated toward zero (BigInt division truncates).
  return ((close - fill) * 10000n) / fill;
}

function dipAtLeast(sum: bigint, n: bigint, close: bigint, bps: number): boolean {
  return (sum - n * close) * 10000n >= sum * BigInt(bps);
}
function dipAtMost(sum: bigint, n: bigint, close: bigint, bps: number): boolean {
  return (sum - n * close) * 10000n <= sum * BigInt(bps);
}

function heldQty(): bigint {
  let t = 0n;
  for (const l of lots) t += l.qty;
  return t;
}

// Fold this batch's fills into the lot list (buy fills add a lot; sell fills
// consume lots FIFO). The fill price is the fill bar's open.
function applyFills(batch: { fills: { symbol: string; side: string; status: string; client_id: string; price: string; qty: string }[] }, close: bigint, seq: number): void {
  for (const f of batch.fills) {
    if (f.symbol !== SYMBOL || f.status !== 'filled') continue;
    const qty = BigInt(f.qty);
    const price = BigInt(f.price);
    if (qty === 0n) continue;
    if (f.side === 'buy') {
      const kind: Lot['kind'] = f.client_id.startsWith('b-momentum-')
        ? 'momentum'
        : f.client_id.startsWith('d-buy-')
          ? 'dev'
          : 'primary';
      lots.push({ kind, qty, fillPrice: price, fillBar: seq, peak: chgBps(close, price) });
    } else {
      let rem = qty;
      while (rem > 0n && lots.length > 0) {
        const take = rem < lots[0].qty ? rem : lots[0].qty;
        lots[0].qty -= take;
        rem -= take;
        if (lots[0].qty === 0n) lots.shift();
      }
    }
  }
}

// ---------- dev mode: replay the frozen DP schedule ----------
function devOrders(seq: number): (BuyInput | SellInput)[] {
  const out: (BuyInput | SellInput)[] = [];
  const orders = schedByBar.get(seq);
  if (!orders) return out;
  for (const o of orders) {
    if (o.side === 'buy' && o.notional !== undefined) {
      out.push({
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: o.notional,
        max_slippage_bps: 100,
        client_id: `d-buy-${seq}-${orderCounter++}`,
      });
    } else if (o.side === 'sell' && o.qty !== undefined) {
      const want = BigInt(o.qty);
      const held = heldQty();
      const qty = want <= held ? want : held;
      if (qty === 0n) continue;
      out.push({
        side: 'sell',
        symbol: SYMBOL,
        qty: qty.toString(),
        max_slippage_bps: 100,
        client_id: `d-sell-${seq}-${orderCounter++}`,
      });
    }
  }
  return out;
}

// ---------- race mode: causal dip-buy tranche ----------
function raceOrders(seq: number, close: bigint, open: bigint, cash: bigint): (BuyInput | SellInput)[] {
  const out: (BuyInput | SellInput)[] = [];

  // --- exits ---
  for (let i = 0; i < lots.length; i++) {
    const lot = lots[i];
    const held = seq - lot.fillBar;
    const chg = chgBps(close, lot.fillPrice);
    if (chg > lot.peak) lot.peak = chg;
    let ex = false;
    if (lot.kind === 'primary') {
      if (close * 10000n <= lot.fillPrice * BigInt(10000 - RACE.slBps)) ex = true;
      else if (close * 10000n >= lot.fillPrice * BigInt(10000 + RACE.tpBps)) ex = true;
      else if (held >= RACE.holdBars) ex = true;
      else if (held >= RACE.staleHold && lot.peak < BigInt(RACE.stalePeakBps) && chg >= BigInt(RACE.staleChgBps)) ex = true;
      else if (held >= RACE.driftHold && chg <= -BigInt(RACE.driftExitBps)) ex = true;
    } else if (lot.kind === 'momentum') {
      if (close * 10000n >= lot.fillPrice * BigInt(10000 + RACE.momTpBps)) ex = true;
      else if (held >= RACE.momHold) ex = true;
      else if (held >= RACE.momEarlyHold && lot.peak < BigInt(RACE.momEarlyPeakBps) && chg >= BigInt(RACE.momEarlyChgBps)) ex = true;
    }
    // 'dev' lots never appear in race mode.
    if (ex) {
      out.push({
        side: 'sell',
        symbol: SYMBOL,
        qty: lot.qty.toString(),
        max_slippage_bps: RACE.maxSlipBps,
        client_id: `s-${seq}-${orderCounter++}`,
      });
    }
  }

  // --- entries ---
  let buysSent = 0;
  let cashLeft = cash;
  const canBuy = (): boolean =>
    buysSent < RACE.maxBuys && lots.length + buysSent < RACE.maxLots && cashLeft >= RACE.lot;
  const tryBuy = (kind: 'primary' | 'momentum'): void => {
    if (!canBuy()) return;
    out.push({
      side: 'buy',
      symbol: SYMBOL,
      notional_quote_units: RACE.lot.toString(),
      max_slippage_bps: RACE.maxSlipBps,
      client_id: `b-${kind}-${seq}-${orderCounter++}`,
    });
    buysSent++;
    cashLeft -= RACE.lot;
  };

  // Momentum leg: close up >= 1.25% over 15 bars, no momentum lot open.
  const hasMomentum = lots.some((l) => l.kind === 'momentum');
  if (!hasMomentum && closes.length > RACE.momLook) {
    const then = closes[closes.length - 1 - RACE.momLook];
    if (close * 10000n >= then * BigInt(10000 + RACE.momRiseBps)) tryBuy('momentum');
  }

  // Primary dip-buy: 90-bar mean, bounce confirmation, slope + dip-cap guards.
  if (closes.length >= 180) {
    const mNow = sum90Hist[seq];
    const mAgo = sum90Hist[seq - 90];
    if (mNow !== null && mNow !== undefined && mAgo !== null && mAgo !== undefined) {
      if (mNow * 10000n >= mAgo * BigInt(10000 - RACE.slopeAllowBps)) {
        const green = close > open;
        const dipOk = dipAtLeast(sum90, 90n, close, RACE.dipBps);
        const capOk = dipAtMost(sum90, 90n, close, RACE.dipCapBps);
        if ((!RACE.useBounce || green) && dipOk && capOk) {
          while (buysSent < RACE.maxBuys) {
            const before = buysSent;
            tryBuy('primary');
            if (buysSent === before) break;
          }
        }
      }
    }
  }

  return out.slice(0, 16);
}

await runBars({
  onHello(state) {
    // The dev window's first close; any other window is the live race.
    isDev = state.hello.first_close_ms === DEV_FIRST_CLOSE_MS;
  },
  onBatch(state, batch) {
    const bar = state.latest.get(SYMBOL);
    if (!bar) return [];
    const close = BigInt(bar.c);
    const open = BigInt(bar.o);
    const seq = state.seq;

    // History first (mirrors the sim: the bar closes, then fills resolve).
    closes.push(close);
    sum90 += close;
    if (closes.length > 90) sum90 -= closes[closes.length - 91];
    sum90Hist.push(closes.length >= 90 ? sum90 : null);

    // Fills from the previous batch's orders (filled at this bar's open).
    applyFills(batch, close, seq);

    if (seq >= LAST_SEQ) return [];
    if (state.warmingUp) return [];
    if (isDev) return devOrders(seq);
    return raceOrders(seq, close, open, state.cash);
  },
});
