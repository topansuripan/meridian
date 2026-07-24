import fs from 'fs';

const path = 'C:/Users/PC/.claude/projects/D--aiproject-meridian/4db310cf-dd0b-4f3d-aca8-d980bc08f7eb/tool-results/be6d43c.txt';
const lines = fs.readFileSync(path, 'utf8');
// Strip line number prefixes (format: spaces + number + arrow)
const cleaned = lines.replace(/^\s*\d+\u2192/gm, '');
const data = JSON.parse(cleaned);
const positions = Object.values(data.positions).filter(p => p.closed);

// Sort by deployed_at
positions.sort((a, b) => new Date(a.deployed_at) - new Date(b.deployed_at));

const results = positions.map((p, i) => {
  const deployed = new Date(p.deployed_at);
  const closed = new Date(p.closed_at);
  const durationMin = Math.round((closed - deployed) / 60000);
  const hours = Math.floor(durationMin / 60);
  const mins = durationMin % 60;

  // Extract close reason from notes
  let closeReason = 'unknown';
  if (p.notes && p.notes.length > 0) {
    const lastNote = p.notes[p.notes.length - 1];
    const match = lastNote.match(/:\s*(.+)$/);
    if (match) closeReason = match[1].trim();
  }

  // Categorize close reason
  let category = 'other';
  if (closeReason.includes('pumped far above range')) category = 'pumped_OOR';
  else if (closeReason.includes('Out of range')) category = 'OOR_timeout';
  else if (closeReason.includes('Low yield')) category = 'low_yield';
  else if (closeReason.includes('Trailing TP')) category = 'trailing_tp';
  else if (closeReason.includes('take profit')) category = 'take_profit';
  else if (closeReason.includes('Stop loss')) category = 'stop_loss';

  return {
    idx: i + 1,
    pool_name: p.pool_name || 'unknown',
    amount_sol: p.amount_sol,
    deployed: p.deployed_at.slice(0, 16),
    closed: p.closed_at.slice(0, 16),
    duration: hours + 'h' + mins + 'm',
    durationMin,
    peak_pnl: p.peak_pnl_pct || 0,
    fees_usd: p.total_fees_claimed_usd || 0,
    closeReason: closeReason.substring(0, 80),
    category,
    strategy: p.strategy || 'bid_ask',
    bin_step: p.bin_step,
    volatility: p.volatility,
    fee_tvl: p.fee_tvl_ratio,
    organic: p.organic_score,
    bins_below: p.bin_range?.bins_below,
    degen: p.degen || false
  };
});

console.log('TOTAL_POSITIONS:', results.length);

// Category stats
const cats = {};
results.forEach(r => { cats[r.category] = (cats[r.category] || 0) + 1; });
console.log('CATEGORIES:', JSON.stringify(cats, null, 2));

// SOL stats
const totalSolDeployed = results.reduce((s, r) => s + r.amount_sol, 0);
console.log('TOTAL_SOL_DEPLOYED:', totalSolDeployed.toFixed(2));

// Win/loss
const wins = results.filter(r => r.category === 'trailing_tp' || r.category === 'take_profit');
const bigWins = results.filter(r => r.peak_pnl >= 3 && r.category !== 'stop_loss');
const losses = results.filter(r => r.category === 'stop_loss');
const pumpedOOR = results.filter(r => r.category === 'pumped_OOR');
const oorTimeout = results.filter(r => r.category === 'OOR_timeout');
const lowYield = results.filter(r => r.category === 'low_yield');

console.log('\n=== WIN/LOSS BREAKDOWN ===');
console.log('Profitable exits (Trailing TP + Take Profit):', wins.length);
console.log('Positions with peak PnL >= 3%:', bigWins.length);
console.log('Stop losses:', losses.length);
console.log('Pumped out of range:', pumpedOOR.length);
console.log('OOR timeout:', oorTimeout.length);
console.log('Low yield closed:', lowYield.length);

// Fees earned from lessons.json
const lessonsPath = 'C:/Users/PC/.claude/projects/D--aiproject-meridian/4db310cf-dd0b-4f3d-aca8-d980bc08f7eb/tool-results/b43732e.txt';
let totalFeesFromLessons = 0;
let totalPnlPositive = 0;
let totalPnlNegative = 0;
let lessonCount = 0;
try {
  const lessonsRaw = fs.readFileSync(lessonsPath, 'utf8');
  const lessonsData = JSON.parse(lessonsRaw);
  lessonsData.lessons.forEach(l => {
    if (l.fees_earned_usd) totalFeesFromLessons += l.fees_earned_usd;
    if (l.pnl_pct > 0) totalPnlPositive++;
    if (l.pnl_pct < 0) totalPnlNegative++;
    lessonCount++;
  });
  console.log('\n=== LESSONS DATA ===');
  console.log('Total lessons recorded:', lessonCount);
  console.log('Total fees earned (from lessons):', totalFeesFromLessons.toFixed(2), 'USD');
  console.log('Positive PnL lessons:', totalPnlPositive);
  console.log('Negative PnL lessons:', totalPnlNegative);
} catch (e) {
  console.log('Could not parse lessons:', e.message);
}

// Average duration by category
console.log('\n=== DURATION BY CATEGORY ===');
for (const [cat, count] of Object.entries(cats)) {
  const catPositions = results.filter(r => r.category === cat);
  const avgDur = catPositions.reduce((s, r) => s + r.durationMin, 0) / count;
  console.log(`${cat}: avg ${avgDur.toFixed(0)}m (${count} positions)`);
}

// Best performers
console.log('\n=== TOP 10 BY PEAK PNL ===');
const topByPnl = [...results].sort((a, b) => b.peak_pnl - a.peak_pnl).slice(0, 10);
topByPnl.forEach(r => {
  console.log(`#${r.idx} ${r.pool_name} | ${r.amount_sol} SOL | peak ${r.peak_pnl}% | ${r.duration} | ${r.category} | bins_below=${r.bins_below} | vol=${r.volatility ?? 'null'} | fee_tvl=${r.fee_tvl ?? 'null'} | degen=${r.degen}`);
});

// Worst performers
console.log('\n=== STOP LOSSES ===');
losses.forEach(r => {
  console.log(`#${r.idx} ${r.pool_name} | ${r.amount_sol} SOL | peak ${r.peak_pnl}% | ${r.duration} | ${r.closeReason}`);
});

// Print full position table
console.log('\n=== FULL POSITION TABLE ===');
console.log('#\tPool\tSOL\tDuration\tPeak%\tFees$\tCategory\tStrategy\tBinStep\tVol\tFeeTVL\tOrganic\tBins\tDegen\tDate');
results.forEach(r => {
  console.log(`${r.idx}\t${r.pool_name}\t${r.amount_sol}\t${r.duration}\t${r.peak_pnl}\t${r.fees_usd}\t${r.category}\t${r.strategy}\t${r.bin_step}\t${r.volatility ?? '-'}\t${(r.fee_tvl ?? '-')}\t${r.organic ?? '-'}\t${r.bins_below}\t${r.degen}\t${r.deployed.slice(5)}`);
});

// Summary stats by pool name (repeated pools)
console.log('\n=== REPEAT POOL STATS ===');
const poolStats = {};
results.forEach(r => {
  if (poolStats[r.pool_name] === undefined) poolStats[r.pool_name] = { count: 0, wins: 0, totalPeak: 0, totalDuration: 0, totalSol: 0 };
  poolStats[r.pool_name].count++;
  if (r.category === 'trailing_tp' || r.category === 'take_profit') poolStats[r.pool_name].wins++;
  poolStats[r.pool_name].totalPeak += r.peak_pnl;
  poolStats[r.pool_name].totalDuration += r.durationMin;
  poolStats[r.pool_name].totalSol += r.amount_sol;
});
const sorted = Object.entries(poolStats).sort((a, b) => b[1].count - a[1].count);
sorted.forEach(([name, s]) => {
  if (s.count >= 2) {
    console.log(`${name}: ${s.count} deploys, ${s.wins} wins, avg peak ${(s.totalPeak / s.count).toFixed(2)}%, avg dur ${(s.totalDuration / s.count).toFixed(0)}m, total ${s.totalSol.toFixed(2)} SOL`);
  }
});

// Degen vs normal
const degenPositions = results.filter(r => r.degen);
const normalPositions = results.filter(r => r.degen === false);
console.log('\n=== DEGEN vs NORMAL ===');
if (degenPositions.length > 0) {
  console.log(`Degen: ${degenPositions.length} positions, avg peak ${(degenPositions.reduce((s,r) => s + r.peak_pnl, 0) / degenPositions.length).toFixed(2)}%`);
}
console.log(`Normal: ${normalPositions.length} positions, avg peak ${(normalPositions.reduce((s,r) => s + r.peak_pnl, 0) / normalPositions.length).toFixed(2)}%`);
