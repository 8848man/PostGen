import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { activeScope, applyCommands, defaultProfile, loadProfile, profilePath, recordStyleEvent, recordSuggestionDecision, saveProfile } from '../skill/postgen/scripts/profile.mjs';

test('profile commands are validated and direct choices override preset values', () => {
  const p=defaultProfile();
  const next=applyCommands(p,[{operation:'set_field',path:'tone',value:'간결한 존댓말',expectedRevision:0,scope:'user'}]);
  assert.equal(next.fields.tone.value,'간결한 존댓말');assert.equal(next.fields.tone.provenance,'user');assert.equal(next.revision,1);
  assert.throws(()=>applyCommands(next,[{operation:'set_field',path:'secret',value:'x',expectedRevision:1,scope:'user'}]));
  assert.throws(()=>applyCommands(next,[{operation:'set_field',path:'tone',value:'x',expectedRevision:0,scope:'user'}]));
  assert.throws(()=>applyCommands(next,[{operation:'set_topic_choice',path:'',value:'yes',expectedRevision:1,scope:'user'}]));
});

test('style suggestions wait for the threshold and respect refusal', () => {
  let p=defaultProfile(),r;
  for(let i=0;i<3;i++){r=recordStyleEvent(p,'tone');p=r.profile;assert.equal(r.shouldSuggest,i===2)}
  p=recordSuggestionDecision(p,'tone','rejected');
  r=recordStyleEvent(p,'tone');assert.equal(r.shouldSuggest,false);
});

test('workspace profile stays separate from the user profile', () => {
  const root=fs.mkdtempSync(path.join(process.cwd(),'tests','.postgen-profile-'));
  const previous=process.cwd(),old=process.env.POSTGEN_DATA_DIR;
  try {
    process.chdir(root);process.env.POSTGEN_DATA_DIR=path.join(root,'user-data');
    const user=loadProfile('user');assert.equal(activeScope(),'user');
    const workspace=loadProfile('workspace');assert.equal(workspace.scope,'workspace');
    assert.deepEqual(workspace.references,[]);
    const next=applyCommands(workspace,[{operation:'set_field',path:'tone',value:'프로젝트 어투',expectedRevision:0,scope:'workspace'}]);
    saveProfile(next,0);assert.equal(activeScope(),'workspace');
    assert.equal(loadProfile().fields.tone.value,'프로젝트 어투');
    assert.equal(loadProfile('user').fields.tone.value,user.fields.tone.value);
    assert.ok(profilePath('workspace').startsWith(root));
  } finally {process.chdir(previous);if(old===undefined)delete process.env.POSTGEN_DATA_DIR;else process.env.POSTGEN_DATA_DIR=old;fs.rmSync(root,{recursive:true,force:true});}
});
