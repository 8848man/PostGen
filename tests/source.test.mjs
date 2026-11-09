import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { collect, discover, read } from '../skill/postgen/scripts/collect.mjs';
import { sourceId } from '../skill/postgen/scripts/source-providers.mjs';

function safeRemoveTemp(root) {
  const parent=path.resolve(os.tmpdir())+path.sep;
  const target=path.resolve(root);
  if(!target.startsWith(parent))throw new Error('Refusing to remove a path outside the test temp directory');
  fs.rmSync(target,{recursive:true,force:true});
}

function withSourceHomes(prefix, run) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),prefix));
  const oldCodex=process.env.CODEX_HOME, oldClaude=process.env.CLAUDE_CONFIG_DIR;
  process.env.CODEX_HOME=path.join(root,'codex');process.env.CLAUDE_CONFIG_DIR=path.join(root,'claude');
  try { return run(root); }
  finally {
    if(oldCodex===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldCodex;
    if(oldClaude===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=oldClaude;
    safeRemoveTemp(root);
  }
}
const writeRows=(file,rows,eol='\n')=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,rows.map(row=>typeof row==='string'?row:JSON.stringify(row)).join(eol));};
const codexMeta=(cwd,id,timestamp)=>({type:'session_meta',payload:{cwd,id,timestamp}});
const codexUser=text=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
const codexFinal=text=>({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text}]}});
const claudeRow=(type,cwd,sessionId,timestamp,message,extra={})=>({type,cwd,sessionId,timestamp,message,...extra});
const CATALOG_FIELDS=['capturedAt','characterCount','messageCount','preview','provider','sourceId'];
const BUNDLE_DOCUMENT_FIELDS=['capturedAt','diagnostics','messages','provider','sessionId','sourceId','workspaceRef'];

test('internal guardian approval sessions are not offered as writing sources', () => withSourceHomes('postgen-guardian-', root => {
  const workspace=path.join(root,'work');fs.mkdirSync(workspace);
  const sessions=path.join(process.env.CODEX_HOME,'sessions');
  writeRows(path.join(sessions,'work.jsonl'),[
    codexMeta(workspace,'user-work','2026-10-27T00:00:00Z'),codexUser('Design the article'),codexFinal('Draft complete')
  ]);
  writeRows(path.join(sessions,'review.jsonl'),[
    {type:'session_meta',payload:{cwd:workspace,id:'review',timestamp:'2026-10-27T01:00:00Z',source:{subagent:{other:'guardian'}}}},
    codexUser('The following is an approval assessment'),codexFinal('{"outcome":"allow"}')
  ]);
  const catalog=discover(workspace,{includeGit:false});
  assert.equal(catalog.total,1);
  assert.equal(catalog.sources[0].preview,'Design the article');
}));

test('collects only completed user and final-answer messages for the current workspace', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'postgen-source-'));
  try {
    const home=path.join(root,'codex'), a=path.join(root,'a'), b=path.join(root,'b');
    fs.mkdirSync(path.join(home,'sessions'),{recursive:true});fs.mkdirSync(a);fs.mkdirSync(b);
    const record=(cwd,id,content)=>[
      {type:'session_meta',payload:{cwd,id,timestamp:'2026-10-20T00:00:00Z'}},
      {type:'response_item',payload:{type:'message',role:'developer',content:[{type:'input_text',text:'PRIVATE SYSTEM INSTRUCTIONS'}]}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:content}]}},
      {type:'response_item',payload:{type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'internal commentary'}]}},
      {type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'A finished answer'}]}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'UNFINISHED REQUEST'}]}}
    ].map(x=>JSON.stringify(x)).join('\n');
    fs.writeFileSync(path.join(home,'sessions','a.jsonl'),record(a,'a-id','A user request'));
    fs.writeFileSync(path.join(home,'sessions','b.jsonl'),record(b,'b-id','OTHER WORKSPACE SECRET'));
    const old=process.env.CODEX_HOME, oldClaude=process.env.CLAUDE_CONFIG_DIR;
    process.env.CODEX_HOME=home;process.env.CLAUDE_CONFIG_DIR=path.join(root,'claude');
    try { const result=collect(a);const text=JSON.stringify(result);assert.equal(result.sessionCount,1);assert.match(text,/A user request/);assert.match(text,/A finished answer/);assert.doesNotMatch(text,/PRIVATE SYSTEM INSTRUCTIONS|internal commentary|UNFINISHED REQUEST|OTHER WORKSPACE SECRET/);assert.equal(result.sourceDocuments[0].messages[0].locator.line,3); }
    finally {if(old===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old;if(oldClaude===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=oldClaude;}
  } finally {safeRemoveTemp(root);}
});

test('discovers Codex and Claude Code by workspace, then reads only chosen evidence within a budget', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'postgen-mixed-'));
  const oldCodex=process.env.CODEX_HOME, oldClaude=process.env.CLAUDE_CONFIG_DIR;
  try {
    const workspace=path.join(root,'work'), other=path.join(root,'other');
    const codex=path.join(root,'codex','sessions'), claude=path.join(root,'claude','projects','work');
    for(const dir of [workspace,other,codex,claude])fs.mkdirSync(dir,{recursive:true});
    const write=(file,rows)=>fs.writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n'));
    write(path.join(codex,'one.jsonl'),[
      {type:'session_meta',payload:{cwd:workspace,id:'codex-one',timestamp:'2026-10-20T00:00:00Z'}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Mixed workflow started'}]}},
      {type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Codex decided the plan'}]}}
    ]);
    write(path.join(claude,'two.jsonl'),[
      {type:'user',cwd:workspace,sessionId:'claude-two',timestamp:'2026-10-21T00:00:00Z',message:{role:'user',content:'Claude continued the same workflow'}},
      {type:'assistant',cwd:workspace,sessionId:'claude-two',timestamp:'2026-10-21T00:01:00Z',message:{id:'a1',role:'assistant',content:[{type:'tool_use',name:'Read',input:{}},{type:'text',text:'Intermediate'}],stop_reason:'tool_use'}},
      {type:'assistant',cwd:workspace,sessionId:'claude-two',timestamp:'2026-10-21T00:02:00Z',message:{id:'a2',role:'assistant',content:[{type:'text',text:'Claude finished the result'}],stop_reason:'end_turn'}},
      {type:'user',cwd:workspace,sessionId:'claude-two',timestamp:'2026-10-21T00:03:00Z',message:{role:'user',content:'INCOMPLETE SECRET'}}
    ]);
    write(path.join(claude,'other.jsonl'),[
      {type:'user',cwd:other,sessionId:'other',message:{role:'user',content:'OTHER WORKSPACE SECRET'}},
      {type:'assistant',cwd:other,sessionId:'other',message:{role:'assistant',content:[{type:'text',text:'Done'}],stop_reason:'end_turn'}}
    ]);
    process.env.CODEX_HOME=path.join(root,'codex');process.env.CLAUDE_CONFIG_DIR=path.join(root,'claude');
    const catalog=discover(workspace,{includeGit:false});
    assert.equal(catalog.total,2);
    assert.deepEqual(new Set(catalog.sources.map(source=>source.provider)),new Set(['codex-jsonl','claude-code-jsonl']));
    assert.doesNotMatch(JSON.stringify(catalog),/Codex decided the plan|Claude finished the result|OTHER WORKSPACE SECRET/);
    const chosen=catalog.sources.find(source=>source.provider==='claude-code-jsonl');
    const bundle=read(workspace,{sourceIds:[chosen.sourceId],includeGit:false,maxChars:1000});
    const output=JSON.stringify(bundle);
    assert.equal(bundle.sessionCount,1);
    assert.match(output,/Claude continued the same workflow|Claude finished the result/);
    assert.doesNotMatch(output,/Intermediate|INCOMPLETE SECRET|OTHER WORKSPACE SECRET|Codex decided the plan/);
    assert.equal(bundle.sourceDocuments[0].messages[0].locator.line,1);
  } finally {
    if(oldCodex===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldCodex;
    if(oldClaude===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=oldClaude;
    safeRemoveTemp(root);
  }
});

test('explicit logs retain line locators and report truncation without exceeding the read budget', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'postgen-log-'));
  const oldCodex=process.env.CODEX_HOME, oldClaude=process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CODEX_HOME=path.join(root,'none');process.env.CLAUDE_CONFIG_DIR=path.join(root,'also-none');
    const file=path.join(root,'terminal.log');
    fs.writeFileSync(file,Array.from({length:150},(_,i)=>`line ${i+1} ${'x'.repeat(30)}`).join('\n'));
    const catalog=discover(root,{inputs:[file],includeGit:false});
    assert.equal(catalog.total,1);
    const bundle=read(root,{inputs:[file],sourceIds:[catalog.sources[0].sourceId],maxChars:1000,includeGit:false});
    assert.ok(bundle.sourceDocuments[0].messages.reduce((size,m)=>size+m.content.length,0)<=1000);
    assert.ok(bundle.diagnostics.some(item=>item.code==='truncated'));
    assert.equal(bundle.sourceDocuments[0].messages[0].locator.line,1);
  } finally {
    if(oldCodex===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldCodex;
    if(oldClaude===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=oldClaude;
    safeRemoveTemp(root);
  }
});

test('Git commits are optional, read only after selection, and remain distinct from conversations', (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'postgen-git-'));
  const oldCodex=process.env.CODEX_HOME, oldClaude=process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CODEX_HOME=path.join(root,'none');process.env.CLAUDE_CONFIG_DIR=path.join(root,'also-none');
    const git=(args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']});
    try { git(['init','-q']); }
    catch { t.skip('sandbox does not allow temporary Git repository creation'); return; }
    fs.writeFileSync(path.join(root,'note.txt'),'observed artifact\n');
    git(['add','note.txt']);
    git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Record the result']);
    const catalog=discover(root);
    assert.equal(catalog.total,1);
    assert.equal(catalog.sources[0].provider,'git-commit');
    assert.match(catalog.sources[0].preview,/Record the result/);
    assert.doesNotMatch(JSON.stringify(catalog),/observed artifact/);
    const bundle=read(root,{sourceIds:[catalog.sources[0].sourceId]});
    assert.match(JSON.stringify(bundle),/observed artifact/);
    assert.equal(bundle.sourceDocuments[0].provider,'git-commit');
  } finally {
    if(oldCodex===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldCodex;
    if(oldClaude===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=oldClaude;
    safeRemoveTemp(root);
  }
});

test('mixed catalog keeps source-catalog/v1 fields, isolates folders, and survives damaged or changed records', () => withSourceHomes('postgen-catalog-', root => {
  const workspace=path.join(root,'work'), other=path.join(root,'other');
  for(const dir of [workspace,path.join(workspace,'sub'),path.join(root,'work-old'),other])fs.mkdirSync(dir,{recursive:true});
  const codex=path.join(root,'codex','sessions'), claude=path.join(root,'claude','projects');
  writeRows(path.join(codex,'2026','10','22','a.jsonl'),[codexMeta(workspace,'codex-a','2026-10-22T00:00:00Z'),codexUser('Codex planned the migration'),codexFinal('CODEX ANSWER BODY')]);
  writeRows(path.join(codex,'sibling.jsonl'),[codexMeta(path.join(root,'work-old'),'s','2026-10-22T00:00:00Z'),codexUser('SIBLING PREFIX SECRET'),codexFinal('Done')]);
  writeRows(path.join(codex,'nested.jsonl'),[codexMeta(path.join(workspace,'sub'),'n','2026-10-22T00:00:00Z'),codexUser('NESTED FOLDER SECRET'),codexFinal('Done')]);
  writeRows(path.join(codex,'new-header.jsonl'),[{type:'turn_context',payload:{cwd:workspace}},codexUser('UNRECOGNIZED HEADER SECRET'),codexFinal('Done')]);
  writeRows(path.join(codex,'empty.jsonl'),['']);
  // Claude Code may start with a summary row that has no cwd, and may store user content as a string.
  writeRows(path.join(claude,'work','e.jsonl'),[{type:'summary',summary:'Earlier summary',leafUuid:'u1'},
    claudeRow('user',workspace,'claude-e','2026-10-21T00:00:00Z',{role:'user',content:'Claude reviewed the rollback'}),
    '{"type":"assistant","cwd":',
    claudeRow('assistant',workspace,'claude-e','2026-10-21T00:01:00Z',{id:'m1',role:'assistant',content:[{type:'text',text:'CLAUDE ANSWER BODY verified'}],stop_reason:'end_turn'})]);
  // A nested cwd that names the workspace must not pull in another project's session.
  writeRows(path.join(claude,'decoy','f.jsonl'),[
    claudeRow('user',other,'decoy','2026-10-24T00:00:00Z',{role:'user',content:'DECOY SECRET'},{toolUseResult:{cwd:workspace}}),
    claudeRow('assistant',other,'decoy','2026-10-24T00:01:00Z',{id:'d1',role:'assistant',content:[{type:'text',text:'Done'}],stop_reason:'end_turn'})]);
  writeRows(path.join(claude,'broken','g.jsonl'),['{"cwd":"'+workspace.replace(/\\/g,'\\\\')+'"', 'not json at all']);

  const catalog=discover(workspace,{includeGit:false});
  assert.equal(catalog.schemaVersion,'source-catalog/v1');
  assert.deepEqual(Object.keys(catalog).sort(),['diagnostics','offset','schemaVersion','sources','total','workspaceRef']);
  assert.equal(catalog.total,2);
  for(const source of catalog.sources){assert.deepEqual(Object.keys(source).sort(),CATALOG_FIELDS);assert.ok(source.preview.length<=140);}
  assert.deepEqual(catalog.sources.map(source=>source.provider),['codex-jsonl','claude-code-jsonl']);
  assert.deepEqual(catalog.sources.map(source=>source.sourceId),[sourceId('codex','codex-a'),sourceId('claude-code','claude-e')]);
  assert.deepEqual(catalog.sources.map(source=>source.preview),['Codex planned the migration','Claude reviewed the rollback']);
  assert.deepEqual(catalog.diagnostics,[]);
  assert.equal(catalog.sources[0].messageCount,2);
  assert.equal(catalog.sources[0].characterCount,'Codex planned the migration'.length+'CODEX ANSWER BODY'.length);
  assert.doesNotMatch(JSON.stringify(catalog),/ANSWER BODY|SECRET|Earlier summary/);
  const ranked=discover(workspace,{includeGit:false,query:'verified'});
  assert.deepEqual(ranked.sources.map(source=>source.sourceId),[sourceId('claude-code','claude-e'),sourceId('codex','codex-a')],
    'relevance still scores message bodies that are not printed');
  assert.deepEqual(ranked.sources.map(source=>source.preview),['Claude reviewed the rollback','Codex planned the migration']);
  assert.equal(ranked.total,2);
  const codexBundle=read(workspace,{sourceIds:[catalog.sources[0].sourceId],includeGit:false});
  assert.deepEqual(codexBundle.sourceDocuments.map(document=>document.sourceId),[sourceId('codex','codex-a')]);
  assert.deepEqual(codexBundle.sourceDocuments[0].messages.map(message=>message.locator),
    [{line:2,messageIndex:1},{line:3,messageIndex:2}]);
  assert.deepEqual(codexBundle.sourceDocuments[0].messages.map(message=>message.content),
    ['Codex planned the migration','CODEX ANSWER BODY']);
  assert.deepEqual(codexBundle.sourceDocuments[0].diagnostics,[]);
  assert.deepEqual(codexBundle.diagnostics,[]);
  const bundle=read(workspace,{sourceIds:[catalog.sources[1].sourceId],includeGit:false});
  assert.deepEqual(bundle.sourceDocuments.map(document=>document.sourceId),[sourceId('claude-code','claude-e')]);
  assert.deepEqual(bundle.sourceDocuments[0].diagnostics,['1 malformed lines skipped']);
  assert.deepEqual(bundle.sourceDocuments[0].messages.map(message=>message.locator),
    [{line:2,messageIndex:1},{line:4,messageIndex:2}]);
  assert.deepEqual(bundle.sourceDocuments[0].messages.map(message=>message.content),['Claude reviewed the rollback','CLAUDE ANSWER BODY verified']);
  assert.deepEqual(bundle.diagnostics,[]);
  assert.doesNotMatch(JSON.stringify(bundle),/SECRET|Earlier summary|CODEX ANSWER BODY/);
}));

test('selected reads keep sourceId, line locators, budget, and truncation diagnostics', () => withSourceHomes('postgen-read-', root => {
  const workspace=path.join(root,'work');fs.mkdirSync(workspace);
  const answer='A'.repeat(3000);
  writeRows(path.join(root,'codex','sessions','r.jsonl'),[codexMeta(workspace,'codex-r','2026-10-23T00:00:00Z'),
    '{"type":"response_item", broken',
    {type:'event_msg',payload:{type:'token_count',info:{}}},
    {type:'response_item',payload:{type:'message',role:'user',content:'Plain string request'}},
    codexFinal(answer),'',codexUser('Follow-up question'),codexFinal('Closing answer')],'\r\n');
  writeRows(path.join(root,'claude','projects','work','s.jsonl'),[
    claudeRow('user',workspace,'claude-s','2026-10-20T00:00:00Z',{role:'user',content:'CLAUDE NOT SELECTED'}),
    claudeRow('assistant',workspace,'claude-s','2026-10-20T00:01:00Z',{id:'c1',role:'assistant',content:[{type:'text',text:'Done'}],stop_reason:'end_turn'})]);
  const catalog=discover(workspace,{includeGit:false});
  const codex=catalog.sources.find(source=>source.provider==='codex-jsonl');
  assert.equal(codex.characterCount,'Plain string request'.length+answer.length+'Follow-up question'.length+'Closing answer'.length);

  const full=read(workspace,{sourceIds:[codex.sourceId],includeGit:false,maxChars:120000});
  assert.deepEqual(full.sourceDocuments[0].messages.map(message=>message.locator),
    [{line:4,messageIndex:1},{line:5,messageIndex:2},{line:7,messageIndex:3},{line:8,messageIndex:4}]);
  assert.ok(!full.diagnostics.some(item=>item.code==='truncated'));

  const missing='ffffffffffffffff';
  const bundle=read(workspace,{sourceIds:[codex.sourceId,missing],includeGit:false,maxChars:1000});
  const [document]=bundle.sourceDocuments;
  assert.equal(bundle.schemaVersion,'source-bundle/v1');
  assert.equal(bundle.sessionCount,1);
  assert.equal(bundle.characterBudget,1000);
  assert.equal(document.sourceId,codex.sourceId);
  assert.deepEqual(Object.keys(document).sort(),BUNDLE_DOCUMENT_FIELDS);
  assert.deepEqual(document.diagnostics,['1 malformed lines skipped']);
  assert.ok(document.messages.reduce((size,message)=>size+message.content.length,0)<=1000);
  assert.deepEqual([document.messages[0].locator.line,document.messages[0].excerpt],[4,'start']);
  assert.deepEqual([document.messages.at(-1).locator.line,document.messages.at(-1).excerpt],[8,'end']);
  assert.ok(document.messages.every(message=>[4,5,7,8].includes(message.locator.line)));
  assert.ok(bundle.diagnostics.some(item=>item.code==='truncated'&&item.sourceId===codex.sourceId));
  assert.ok(bundle.diagnostics.some(item=>item.code==='source_unavailable'&&item.sourceId===missing));
  assert.doesNotMatch(JSON.stringify(bundle),/CLAUDE NOT SELECTED/);

  const claude=catalog.sources.find(source=>source.provider==='claude-code-jsonl');
  const exhausted=read(workspace,{sourceIds:[codex.sourceId,claude.sourceId],includeGit:false,maxChars:1000});
  assert.equal(exhausted.characterBudget,1000);
  assert.deepEqual(exhausted.sourceDocuments.map(source=>source.sourceId),[codex.sourceId]);
  assert.ok(exhausted.diagnostics.some(item=>item.code==='budget_exhausted'&&item.sourceId===claude.sourceId));
  assert.doesNotMatch(JSON.stringify(exhausted),/CLAUDE NOT SELECTED/);
}));

test('lines larger than the read chunk keep multibyte text, counts, and locators intact', () => withSourceHomes('postgen-large-line-', root => {
  const workspace=path.join(root,'work');fs.mkdirSync(workspace);
  const request='가'.repeat(1_200_000)+'끝'; // About 3.6 MB, so several 1 MiB chunk edges split a character.
  writeRows(path.join(root,'codex','sessions','big.jsonl'),[codexMeta(workspace,'big','2026-10-23T00:00:00Z'),codexUser(request),codexFinal('done')]);
  const catalog=discover(workspace,{includeGit:false});
  assert.equal(catalog.sources[0].characterCount,request.length+'done'.length);
  assert.equal(catalog.sources[0].preview,'가'.repeat(140));
  const bundle=read(workspace,{sourceIds:[catalog.sources[0].sourceId],includeGit:false,maxChars:120000});
  const output=JSON.stringify(bundle);
  assert.doesNotMatch(output,/�/);
  const messages=bundle.sourceDocuments[0].messages;
  assert.deepEqual(messages.map(message=>[message.locator.line,message.excerpt]),[[2,'start'],[2,'end'],[3,'end']]);
  assert.ok(messages[1].content.endsWith('가끝'));
  assert.ok(bundle.diagnostics.some(item=>item.code==='truncated'));
}));

test('a selected source that changes workspace after discovery is not read', () => withSourceHomes('postgen-moved-', root => {
  const workspace=path.join(root,'work'), other=path.join(root,'other');fs.mkdirSync(workspace);fs.mkdirSync(other);
  const file=path.join(root,'codex','sessions','m.jsonl');
  writeRows(file,[codexMeta(workspace,'moved','2026-10-23T00:00:00Z'),codexUser('Before move'),codexFinal('Done')]);
  const [source]=discover(workspace,{includeGit:false}).sources;
  writeRows(file,[codexMeta(other,'moved','2026-10-23T00:00:00Z'),codexUser('MOVED SECRET'),codexFinal('Done')]);
  const bundle=read(workspace,{sourceIds:[source.sourceId],includeGit:false});
  assert.equal(bundle.sessionCount,0);
  assert.doesNotMatch(JSON.stringify(bundle),/MOVED SECRET/);
  assert.ok(bundle.diagnostics.some(item=>item.code==='source_unavailable'&&item.sourceId===source.sourceId));
  assert.ok(bundle.diagnostics.some(item=>item.code==='insufficient_sources'));
}));

// Opt-in: POSTGEN_BENCH=1 [POSTGEN_BENCH_MB=128] [POSTGEN_BENCH_RUNS=3].
// For a verified previous implementation, set POSTGEN_BENCH_BASELINE to its directory
// and POSTGEN_BENCH_BASELINE_SOURCE to its full Git commit ID, plus
// POSTGEN_BENCH_BASELINE_COLLECT_SHA256 and POSTGEN_BENCH_BASELINE_PROVIDERS_SHA256.
// The digests bind the named source to the two implementation files; without all of
// these, only current measurements are reported and comparison is explicitly unavailable.
test('benchmark: candidate discovery time and peak memory on a large synthetic mixed history', { skip: !process.env.POSTGEN_BENCH }, t => withSourceHomes('postgen-bench-', root => {
  const workspace=path.join(root,'work');fs.mkdirSync(workspace);
  const others=Array.from({length:8},(_,i)=>path.join(root,`other-${i}`));for(const dir of others)fs.mkdirSync(dir);
  const targetBytes=(Number(process.env.POSTGEN_BENCH_MB)||128)*1024*1024, fileBytes=1024*1024;
  const text=(n,hot)=>`${'synthetic session evidence '.repeat(70)}turn ${n}${hot?' deploy rollback':''}`;
  let written=0, inputFiles=0;
  for(let file=0;written<targetBytes;file++){
    const cwd=file%5<2?workspace:others[file%others.length], hot=file%7===0;
    const timestamp=new Date(Date.UTC(2026,9,1)+file*60_000).toISOString();
    const rows=[];let size=0;
    if(file%2===0){
      rows.push(codexMeta(cwd,`codex-${file}`,timestamp));
      for(let turn=0;size<fileBytes;turn++){const pair=[codexUser(text(turn,hot)),codexFinal(text(turn,false))].map(row=>JSON.stringify(row));rows.push(...pair);size+=pair[0].length+pair[1].length;}
      const filePath=path.join(root,'codex','sessions',`f${file}.jsonl`);
      writeRows(filePath,rows);written+=fs.statSync(filePath).size;inputFiles++;
    } else {
      for(let turn=0;size<fileBytes;turn++){const pair=[claudeRow('user',cwd,`claude-${file}`,timestamp,{role:'user',content:text(turn,hot)}),
        claudeRow('assistant',cwd,`claude-${file}`,timestamp,{id:`m${turn}`,role:'assistant',content:[{type:'text',text:text(turn,false)}],stop_reason:'end_turn'})].map(row=>JSON.stringify(row));
        rows.push(...pair);size+=pair[0].length+pair[1].length;}
      const filePath=path.join(root,'claude','projects',`p${file%10}`,`f${file}.jsonl`);
      writeRows(filePath,rows);written+=fs.statSync(filePath).size;inputFiles++;
    }
  }
  const discoveryOptions={includeGit:false,query:'deploy rollback',limit:100};
  const code=`const { discover } = await import(process.env.BENCH_MODULE);
const started = performance.now();
const catalog = discover(process.env.BENCH_WORKSPACE, JSON.parse(process.env.BENCH_OPTIONS));
console.log(JSON.stringify({ elapsedMs: performance.now() - started, maxRssKb: process.resourceUsage().maxRSS, catalog }));`;
  const currentHref=new URL('../skill/postgen/scripts/collect.mjs',import.meta.url).href;
  const currentCollect=new URL('../skill/postgen/scripts/collect.mjs',import.meta.url);
  const currentProviders=new URL('../skill/postgen/scripts/source-providers.mjs',import.meta.url);
  const baselineDir=process.env.POSTGEN_BENCH_BASELINE;
  const baselineSource=process.env.POSTGEN_BENCH_BASELINE_SOURCE;
  const expectedCollect=process.env.POSTGEN_BENCH_BASELINE_COLLECT_SHA256;
  const expectedProviders=process.env.POSTGEN_BENCH_BASELINE_PROVIDERS_SHA256;
  const sha256=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const currentDigests={collect:sha256(currentCollect),providers:sha256(currentProviders)};
  t.diagnostic(JSON.stringify({benchmark:'candidate discovery',node:process.version,
    os:{platform:process.platform,release:os.release(),arch:process.arch},
    inputBytes:written,inputFiles,
    options:discoveryOptions,collectSha256:currentDigests.collect,providersSha256:currentDigests.providers}));
  const validDigest=value=>/^[0-9a-f]{64}$/i.test(value||'');
  const modules={current:currentHref};
  let comparisonUnavailable;
  if(!baselineDir || !/^[0-9a-f]{40,64}$/i.test(baselineSource||'') || !validDigest(expectedCollect) || !validDigest(expectedProviders)){
    comparisonUnavailable='previous implementation source is unconfirmed: provide baseline directory, full Git commit ID, and SHA-256 digests for collect.mjs and source-providers.mjs';
  } else {
    const scriptDir=fs.existsSync(path.resolve(baselineDir,'skill','postgen','scripts','collect.mjs'))
      ? path.resolve(baselineDir,'skill','postgen','scripts') : path.resolve(baselineDir);
    const collectFile=path.join(scriptDir,'collect.mjs');
    const providersFile=path.join(scriptDir,'source-providers.mjs');
    if(!fs.existsSync(collectFile) || !fs.existsSync(providersFile))
      comparisonUnavailable='previous implementation files are missing';
    else {
      let revision, collectAtCommit, providersAtCommit;
      try {
        const gitRoot=execFileSync('git',['-C',scriptDir,'rev-parse','--show-toplevel'],
          {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
        collectAtCommit=path.relative(gitRoot,collectFile).replace(/\\/g,'/');
        providersAtCommit=path.relative(gitRoot,providersFile).replace(/\\/g,'/');
        if([collectAtCommit,providersAtCommit].some(file=>file.startsWith('../') || path.isAbsolute(file)))
          throw new Error('scripts outside baseline Git repository');
        revision=execFileSync('git',['-C',gitRoot,'rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
        execFileSync('git',['-C',gitRoot,'ls-files','--error-unmatch','--',collectAtCommit,providersAtCommit],{stdio:'ignore'});
        execFileSync('git',['-C',gitRoot,'diff','--quiet','HEAD','--',collectAtCommit,providersAtCommit],{stdio:'ignore'});
      }
      catch { comparisonUnavailable='previous implementation Git revision cannot be verified'; }
      if(!comparisonUnavailable && revision.toLowerCase()!==baselineSource.toLowerCase())
        comparisonUnavailable='previous implementation Git revision differs from the declared source';
      else if(!comparisonUnavailable){
        const committed=file=>execFileSync('git',['-C',scriptDir,'show',`${revision}:${file}`],
          {maxBuffer:16_000_000,stdio:['ignore','pipe','ignore']});
        const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
        try {
          const commitCollect=digest(committed(collectAtCommit));
          const commitProviders=digest(committed(providersAtCommit));
          if(commitCollect!==expectedCollect.toLowerCase())
            comparisonUnavailable='collect.mjs declared SHA-256 differs from the baseline Git commit blob';
          else if(commitProviders!==expectedProviders.toLowerCase())
            comparisonUnavailable='source-providers.mjs declared SHA-256 differs from the baseline Git commit blob';
          else if(sha256(collectFile)!==commitCollect)
            comparisonUnavailable='collect.mjs checked-out SHA-256 differs from the baseline Git commit blob';
          else if(sha256(providersFile)!==commitProviders)
            comparisonUnavailable='source-providers.mjs checked-out SHA-256 differs from the baseline Git commit blob';
          else if(commitCollect===currentDigests.collect && commitProviders===currentDigests.providers)
            comparisonUnavailable='declared previous implementation is byte-identical to the current implementation';
          else {
            modules.baseline=pathToFileURL(collectFile).href;
            t.diagnostic(JSON.stringify({baselineCommit:revision,collectSha256:commitCollect,providersSha256:commitProviders}));
          }
        } catch { comparisonUnavailable='previous implementation Git commit blobs cannot be verified'; }
      }
    }
  }
  const runs=Number(process.env.POSTGEN_BENCH_RUNS)||3;
  assert.ok(Number.isSafeInteger(runs)&&runs>0&&runs<=20,'POSTGEN_BENCH_RUNS must be 1..20');
  const results=Object.fromEntries(Object.keys(modules).map(name=>[name,[]]));
  // One fresh Node process per sample, alternating implementation order per round.
  for(let round=0;round<runs;round++){
    const names=round%2 ? Object.keys(modules).reverse() : Object.keys(modules);
    for(const name of names){
      const sample=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],
        {encoding:'utf8',maxBuffer:64_000_000,env:{...process.env,BENCH_MODULE:modules[name],
          BENCH_WORKSPACE:workspace,BENCH_OPTIONS:JSON.stringify(discoveryOptions)}}));
      results[name].push(sample);
      t.diagnostic(JSON.stringify({implementation:name,round:round+1,elapsedMs:sample.elapsedMs,
        maxRssKb:sample.maxRssKb,candidates:sample.catalog.sources}));
    }
  }
  const median=values=>{const sorted=[...values].sort((a,b)=>a-b);const middle=Math.floor(sorted.length/2);
    return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;};
  for(const [name,samples] of Object.entries(results)){
    const aggregate={implementation:name,source:name==='baseline'?baselineSource:'working tree',inputBytes:written,runs,
      elapsedMsMedian:median(samples.map(sample=>sample.elapsedMs)),
      maxRssKbMedian:median(samples.map(sample=>sample.maxRssKb)),
      maxRssKbHighest:Math.max(...samples.map(sample=>sample.maxRssKb)),total:samples[0].catalog.total};
    t.diagnostic(JSON.stringify(aggregate));
    assert.ok(samples.every(sample=>sample.catalog.total===aggregate.total));
    const stable=samples.every(sample=>JSON.stringify(sample.catalog.sources)===JSON.stringify(samples[0].catalog.sources));
    t.diagnostic(JSON.stringify({implementation:name,candidateListsStableAcrossRuns:stable}));
    assert.ok(stable,`${name} candidate list changed between runs`);
  }
  assert.ok(results.current[0].catalog.total>0);
  if(results.baseline){
    const equal=JSON.stringify(results.current[0].catalog.sources)===JSON.stringify(results.baseline[0].catalog.sources);
    t.diagnostic(JSON.stringify({comparison:'available',comparisonSucceeded:equal,candidateListsEqual:equal,
      currentTotal:results.current[0].catalog.total,baselineTotal:results.baseline[0].catalog.total}));
    assert.ok(equal && results.current[0].catalog.total===results.baseline[0].catalog.total,
      'candidate list must not change');
  } else t.diagnostic(JSON.stringify({status:'comparison unavailable',comparisonSucceeded:false,
    reason:comparisonUnavailable}));
}));
