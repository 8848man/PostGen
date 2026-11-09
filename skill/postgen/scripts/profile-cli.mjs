import { applyCommands, loadProfile, recordStyleEvent, recordSuggestionDecision, saveProfile } from './profile.mjs';
const action=process.argv[2]||'show';
try {
  const scopeArg=process.argv.indexOf('--scope');const scope=scopeArg>=0?process.argv[scopeArg+1]:undefined;
  const p=loadProfile(scope);
  if(action==='show') console.log(JSON.stringify(p));
  else if(action==='style-event') {const result=recordStyleEvent(p,process.argv[3]);saveProfile(result.profile,p.revision);console.log(JSON.stringify({count:result.count,shouldSuggest:result.shouldSuggest,threshold:result.profile.suggestionPolicy.threshold}));}
  else if(action==='suggestion-decision') {const next=recordSuggestionDecision(p,process.argv[3],process.argv[4]);saveProfile(next,p.revision);console.log(JSON.stringify({field:process.argv[3],decision:process.argv[4]}));}
  else if(action==='apply') {
    let raw='';for await(const chunk of process.stdin)raw+=chunk;
    const next=applyCommands(p,JSON.parse(raw));saveProfile(next,p.revision);console.log(JSON.stringify(next));
  } else throw new Error('Unknown action');
} catch(e) {console.error(String(e.message||e));process.exitCode=1;}
