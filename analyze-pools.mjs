import fs from 'fs';

const state = JSON.parse(fs.readFileSync('./state.json', 'utf8'));
const poolMem = JSON.parse(fs.readFileSync('./pool-memory.json', 'utf8'));

const zeroDeployPools = Object.entries(poolMem).filter(([_, v]) => v.total_deploys === 0);

console.log('Pools with 0 deploys:', zeroDeployPools.length);
zeroDeployPools.forEach(([addr, entry]) => {
  const openInPool = Object.values(state.positions).filter(p => !p.closed && p.pool === addr);
  const closedInPool = Object.values(state.positions).filter(p => p.closed && p.pool === addr);
  console.log('\n  Pool:', entry.name || addr.slice(0, 8));
  console.log('    - total_deploys:', entry.total_deploys);
  console.log('    - deploys array length:', entry.deploys.length);
  console.log('    - open positions in state:', openInPool.length);
  console.log('    - closed positions in state:', closedInPool.length);
  console.log('    - snapshots recorded:', entry.snapshots?.length || 0);
});
