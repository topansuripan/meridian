import fs from 'fs';

const state = JSON.parse(fs.readFileSync('./state.json', 'utf8'));
const poolMem = JSON.parse(fs.readFileSync('./pool-memory.json', 'utf8'));

const closed = Object.values(state.positions).filter(p => p.closed);
const open = Object.values(state.positions).filter(p => !p.closed);

console.log('State.json stats:');
console.log('  Total positions:', Object.keys(state.positions).length);
console.log('  Open:', open.length);
console.log('  Closed:', closed.length);

console.log('\nPool-Memory.json stats:');
const totalPools = Object.keys(poolMem).length;
const poolsWithDeploys = Object.values(poolMem).filter(p => p.total_deploys > 0).length;
const totalRecordedDeploys = Object.values(poolMem).reduce((sum, p) => sum + p.total_deploys, 0);

console.log('  Total pools tracked:', totalPools);
console.log('  Pools with recorded deploys:', poolsWithDeploys);
console.log('  Total recorded deploy closes:', totalRecordedDeploys);

console.log('\nComparison:');
console.log('  Closed positions in state:', closed.length);
console.log('  Recorded deploys in pool-memory:', totalRecordedDeploys);
console.log('  Match?', closed.length === totalRecordedDeploys ? 'YES' : 'NO - MISMATCH!');
