import { fileURLToPath } from 'node:url';
import path from 'node:path';

const KINDS = new Set(['Fact','Decision','Evidence','Insight','Example','Asset']);
const ORIGINS = new Set(['source','user_assertion','ai_derived']);
const STATUSES = new Set(['confirmed','disputed','needs_review','retracted']);
export function validateKnowledge(pkg) {
  if (!pkg || pkg.schemaVersion !== 'knowledge-package/v1' || typeof pkg.packageId !== 'string' || !pkg.packageId || !Array.isArray(pkg.sourceDocuments) || !Array.isArray(pkg.items) || !Array.isArray(pkg.diagnostics)) throw new Error('Invalid Knowledge Package header');
  const sources = new Map(pkg.sourceDocuments.map(s => [s.sourceId,s]));
  if (sources.size !== pkg.sourceDocuments.length || [...sources.keys()].some(x=>typeof x!=='string'||!x)) throw new Error('Invalid source IDs');
  const ids = new Set();
  for (const item of pkg.items) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || !KINDS.has(item.kind) || typeof item.statement !== 'string' || !item.statement.trim() || !ORIGINS.has(item.origin) || !STATUSES.has(item.status) || !Array.isArray(item.sourceRefs) || !Array.isArray(item.derivedFrom)) throw new Error('Invalid knowledge item');
    ids.add(item.id);
    if (['Fact','Decision'].includes(item.kind) && (item.sourceRefs.length===0 || item.origin==='ai_derived')) throw new Error('Fact or decision needs source evidence');
    if (item.kind==='Insight' && item.origin!=='ai_derived') throw new Error('Insight must be marked derived');
    if (item.kind==='Example' && !['actual','illustrative'].includes(item.exampleType)) throw new Error('Example type required');
    for (const ref of item.sourceRefs) {
      const line = ref?.locator?.line ?? ref?.line;
      if (!ref || !sources.has(ref.sourceId) || !Number.isInteger(line) || line < 1) throw new Error('Invalid source reference');
    }
  }
  for (const item of pkg.items) for (const id of item.derivedFrom) if (!ids.has(id) || id===item.id) throw new Error('Invalid derivation reference');
  return { valid:true, itemCount:pkg.items.length, sourceCount:sources.size };
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try { let raw='';for await(const chunk of process.stdin)raw+=chunk;console.log(JSON.stringify(validateKnowledge(JSON.parse(raw)))); }
  catch(e){console.error(String(e.message||e));process.exitCode=1}
}
