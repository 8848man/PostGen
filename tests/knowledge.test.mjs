import test from 'node:test';
import assert from 'node:assert/strict';
import { validateKnowledge } from '../skill/postgen/scripts/knowledge.mjs';

const base=()=>({schemaVersion:'knowledge-package/v1',packageId:'p1',sourceDocuments:[{sourceId:'s1'}],items:[{id:'f1',kind:'Fact',statement:'A decision was made',origin:'source',status:'confirmed',sourceRefs:[{sourceId:'s1',line:4}],derivedFrom:[]}],diagnostics:[]});
test('Knowledge Package requires traceable facts and valid derivations',()=>{
  assert.equal(validateKnowledge(base()).valid,true);
  const nested=base();nested.items[0].sourceRefs=[{sourceId:'s1',locator:{line:4,messageIndex:1}}];assert.equal(validateKnowledge(nested).valid,true);
  const noEvidence=base();noEvidence.items[0].sourceRefs=[];assert.throws(()=>validateKnowledge(noEvidence));
  const badRef=base();badRef.items[0].sourceRefs[0].sourceId='missing';assert.throws(()=>validateKnowledge(badRef));
  const insight=base();insight.items.push({id:'i1',kind:'Insight',statement:'This may help beginners',origin:'ai_derived',status:'needs_review',sourceRefs:[{sourceId:'s1',line:4}],derivedFrom:['f1']});assert.equal(validateKnowledge(insight).itemCount,2);
});
