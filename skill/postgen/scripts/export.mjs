import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const escapeHtml = s => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
function inline(s) {
  let v=escapeHtml(s);
  v=v.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,(_,label,url)=>`<a href="${escapeHtml(url)}" rel="noopener noreferrer">${label}</a>`);
  v=v.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>').replace(/`([^`]+)`/g,'<code>$1</code>');
  return v;
}
export function renderHtml(markdown) {
  const lines=markdown.replace(/\r\n/g,'\n').split('\n');const out=[];let paragraph=[],list=false,code=false,codeLines=[];
  const flush=()=>{if(paragraph.length){out.push(`<p>${inline(paragraph.join(' '))}</p>`);paragraph=[]}if(list){out.push('</ul>');list=false}};
  for(const line of lines){
    if(line.startsWith('```')){if(code){out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);codeLines=[];code=false}else{flush();code=true}continue}
    if(code){codeLines.push(line);continue}
    if(!line.trim()){flush();continue}
    const h=/^(#{1,6})\s+(.+)$/.exec(line);if(h){flush();out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);continue}
    const li=/^[-*]\s+(.+)$/.exec(line);if(li){if(paragraph.length)flush();if(!list){out.push('<ul>');list=true}out.push(`<li>${inline(li[1])}</li>`);continue}
    if(list)flush();paragraph.push(line.trim());
  }
  flush();if(code)out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  return `<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Postgen 글</title><style>body{font:17px/1.75 system-ui,sans-serif;max-width:760px;margin:3rem auto;padding:0 1.5rem;color:#24332a}h1,h2,h3{line-height:1.3}pre{overflow:auto;background:#f3f5f1;padding:1rem;border-radius:.5rem}a{color:#16714c}</style></head><body>\n${out.join('\n')}\n</body></html>\n`;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),fmt=args[args.indexOf('--format')+1],dest=args[args.indexOf('--output')+1],inputFile=args.includes('--input')?args[args.indexOf('--input')+1]:null;
  if(!['md','html'].includes(fmt)||!dest||dest.startsWith('--')){console.error('Usage: node export.mjs --format md|html --output <path>');process.exit(2)}
  const base=fs.realpathSync(process.cwd()),full=path.resolve(dest);
  const relative=path.relative(base,full);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)){console.error('Output must be inside the current workspace');process.exit(2)}
  if(fs.existsSync(full)){console.error('Output already exists');process.exit(2)}
  let ancestor=path.dirname(full);
  while(!fs.existsSync(ancestor)){const parent=path.dirname(ancestor);if(parent===ancestor)break;ancestor=parent}
  const realAncestor=fs.realpathSync(ancestor),ancestorRelative=path.relative(base,realAncestor);
  if(ancestorRelative==='..'||ancestorRelative.startsWith('..'+path.sep)||path.isAbsolute(ancestorRelative)){console.error('Output path crosses a link outside the workspace');process.exit(2)}
  let markdown='';
  if(inputFile){const source=path.resolve(inputFile);if(!fs.statSync(source).isFile())throw new Error('Input must be a file');markdown=fs.readFileSync(source,'utf8')}
  else for await(const chunk of process.stdin)markdown+=chunk;
  if(!markdown.trim()){console.error('Empty draft');process.exit(2)}
  fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,fmt==='html'?renderHtml(markdown):markdown,{encoding:'utf8',flag:'wx'});
  console.log(full);
}
