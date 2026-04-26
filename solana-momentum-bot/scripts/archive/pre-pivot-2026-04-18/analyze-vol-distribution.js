const fs = require("fs");
const candlePath = process.argv[2] || "data/realtime/sessions/2026-04-05T02-32-07-632Z-live/micro-candles.jsonl";
const lines = fs.readFileSync(candlePath, "utf8").trim().split("\n");

const INTERVAL = 10;
const LOOKBACK = 20;

// 1. Per-pair candle volume stats
const pairVols = new Map();
for (const line of lines) {
  const c = JSON.parse(line);
  if (c.intervalSec !== INTERVAL) continue;
  if (!pairVols.has(c.pairAddress)) {
    pairVols.set(c.pairAddress, { nonZero: 0, count: 0, maxVol: 0, sumVol: 0 });
  }
  const s = pairVols.get(c.pairAddress);
  s.count++;
  s.sumVol += c.volume;
  if (c.volume > 0) s.nonZero++;
  if (c.volume > s.maxVol) s.maxVol = c.volume;
}

console.log("=== 10s Candle Volume Stats per Pair ===");
for (const [pair, s] of [...pairVols.entries()].sort((a, b) => b[1].nonZero - a[1].nonZero)) {
  const pct = (s.nonZero / s.count * 100).toFixed(1);
  const avg = (s.sumVol / s.count).toFixed(6);
  console.log(`  ${pair.slice(0, 12)} | cnt=${String(s.count).padStart(5)} nonZero=${String(s.nonZero).padStart(4)} (${pct.padStart(5)}%) maxVol=${s.maxVol.toFixed(4).padStart(10)} avgVol=${avg}`);
}

// 2. Detailed volumeRatio for active pairs (nonZero > 20)
console.log("\n=== VolumeRatio Detail for Active Pairs ===");
const pairCandles = new Map();
for (const line of lines) {
  const c = JSON.parse(line);
  if (c.intervalSec !== INTERVAL) continue;
  if (!pairCandles.has(c.pairAddress)) pairCandles.set(c.pairAddress, []);
  pairCandles.get(c.pairAddress).push(c);
}

for (const [pair, candles] of pairCandles) {
  const stats = pairVols.get(pair);
  if (stats.nonZero < 5) continue;

  const ratios = [];
  for (let i = LOOKBACK; i < candles.length; i++) {
    const current = candles[i];
    const prev = candles.slice(i - LOOKBACK, i);
    const avgVol = prev.reduce((s, c) => s + c.volume, 0) / LOOKBACK;
    if (avgVol <= 0) {
      ratios.push(0);
      continue;
    }
    ratios.push(current.volume / avgVol);
  }

  const nonZeroRatios = ratios.filter(r => r > 0).sort((a, b) => a - b);
  if (nonZeroRatios.length === 0) {
    console.log(`  ${pair.slice(0, 12)}: all ratios=0 (volume exists but avgVol=0 for lookback windows)`);
    continue;
  }

  const p50 = nonZeroRatios[Math.floor(nonZeroRatios.length * 0.5)];
  const p90 = nonZeroRatios[Math.floor(nonZeroRatios.length * 0.9)];
  const p99 = nonZeroRatios[Math.floor(nonZeroRatios.length * 0.99)];
  const max = nonZeroRatios[nonZeroRatios.length - 1];

  console.log(`  ${pair.slice(0, 12)}: nonZeroRatios=${nonZeroRatios.length}/${ratios.length} P50=${p50.toFixed(2)} P90=${p90.toFixed(2)} P99=${p99.toFixed(2)} max=${max.toFixed(2)}`);

  // How many candles with volume > 0 but ratio = 0 (avgVol was 0)?
  let volButZeroAvg = 0;
  for (let i = LOOKBACK; i < candles.length; i++) {
    const current = candles[i];
    const prev = candles.slice(i - LOOKBACK, i);
    const avgVol = prev.reduce((s, c) => s + c.volume, 0) / LOOKBACK;
    if (current.volume > 0 && avgVol <= 0) volButZeroAvg++;
  }
  if (volButZeroAvg > 0) {
    console.log(`    ^ ${volButZeroAvg} candles had volume>0 but lookback avgVol=0 (sparse trading)`);
  }
}

// 3. Sparsity analysis: how many 10s windows have volume across all pairs
console.log("\n=== Trading Sparsity ===");
let totalCandles = 0;
let totalNonZero = 0;
for (const s of pairVols.values()) {
  totalCandles += s.count;
  totalNonZero += s.nonZero;
}
console.log(`  Total 10s candles: ${totalCandles}`);
console.log(`  Non-zero volume: ${totalNonZero} (${(totalNonZero / totalCandles * 100).toFixed(1)}%)`);
console.log(`  Zero volume: ${totalCandles - totalNonZero} (${((totalCandles - totalNonZero) / totalCandles * 100).toFixed(1)}%)`);

// 4. Temporal density: how are swaps distributed over time for the top pair?
const topPair = [...pairVols.entries()].sort((a, b) => b[1].nonZero - a[1].nonZero)[0];
if (topPair) {
  const [pair, _] = topPair;
  const candles = pairCandles.get(pair);
  console.log(`\n=== Temporal Density: ${pair.slice(0, 12)} ===`);
  // Group by 10-min windows
  const windowMs = 10 * 60 * 1000;
  const windows = new Map();
  for (const c of candles) {
    const ts = new Date(c.timestamp).getTime();
    const windowKey = Math.floor(ts / windowMs) * windowMs;
    if (!windows.has(windowKey)) windows.set(windowKey, { count: 0, vol: 0, nonZero: 0 });
    const w = windows.get(windowKey);
    w.count++;
    w.vol += c.volume;
    if (c.volume > 0) w.nonZero++;
  }
  for (const [ts, w] of [...windows.entries()].sort((a, b) => a[0] - b[0])) {
    const time = new Date(ts).toISOString().slice(11, 19);
    console.log(`  ${time} | candles=${w.count} active=${w.nonZero} vol=${w.vol.toFixed(4)}`);
  }
}
