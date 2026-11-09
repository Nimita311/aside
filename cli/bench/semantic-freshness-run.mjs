import nodeVersion from '../node-version.cjs';
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join, resolve} from 'node:path';

nodeVersion.assertSupportedNode();
const {build} = await import('esbuild');
const cli = fileURLToPath(new URL('..',import.meta.url));
const output = join(cli,'.cache','bench'); mkdirSync(output,{recursive:true});
const args = process.argv.slice(2);
const option = name => {
  const i=args.indexOf(name);
  if(i>=0)return args[i+1];
  return args.find(value=>value.startsWith(name+'='))?.slice(name.length+1);
};
const supplied = option('--module'), ref = option('--ref'), refresh = option('--refresh-provenance');
const sha256 = value => createHash('sha256').update(value).digest('hex');
function provenance(source) {
  const sourceFiles = [];
  const visit = (directory,prefix) => {
    for (const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const path = join(directory,entry.name), relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(path,relative);
      else if (entry.isFile()) {const content=readFileSync(path);sourceFiles.push({path:relative,bytes:content.length,sha256:sha256(content)});}
      else throw new Error(`Unexpected non-regular source input: ${relative}`);
    }
  };
  visit(join(source,'src'),'cli/src');
  return {
    sourceManifestSha256:sha256(JSON.stringify(sourceFiles)),sourceFiles,
  };
}
async function bundle(source,destination) {
  const exports = {
    'src/source/store.ts':['Store'], 'src/daemon/semantic-lifecycle.ts':['InstanceSemanticLifecycle'],
    'src/semantic/search.ts':['SemanticSearchService'],'src/semantic/embedding.ts':['OllamaEmbedder'],
    'bench/semantic-fixture.ts':['writeSemanticFixture'],'src/semantic/source-version.ts':['assertSearchSourceReadable','searchSourceVersion'],
    'src/semantic/documents.ts':['CHUNKER_VERSION','collectDocuments','chunkDocument','hashText'],
  };
  const contents=Object.entries(exports).map(([path,names])=>`export {${names.join(',')}} from ${JSON.stringify(join(source,path))};`).join('\n');
  await build({stdin:{contents,resolveDir:cli,loader:'ts'},outfile:destination,bundle:true,packages:'external',platform:'node',format:'esm',target:'node22.12',loader:{'.md':'text','.yaml':'text'}});
}
if (refresh) {
  if (!supplied || ref) throw new Error('--refresh-provenance requires --module for a current working-tree snapshot, without --ref.');
  const frozen = sha256(readFileSync(resolve(supplied))), result = JSON.parse(readFileSync(resolve(refresh),'utf8'));
  if (result.snapshotSha256 !== frozen) throw new Error('Result does not match the supplied timed module.');
  const check = join(output,'freshness-provenance-check.mjs');
  try {
    await bundle(cli,check);
    if (sha256(readFileSync(check)) !== frozen) throw new Error('Current source no longer matches the timed module; rerun the benchmark.');
  } finally {rmSync(check,{force:true});}
  const metadata=provenance(cli);
  Object.assign(result,metadata,{
    provenanceRefreshVerification:'Supplied timed bundle SHA256 matches the recorded snapshot and a fresh build of the current source; timings preserved.',
  });
  for (const key of ['revision', 'timestamp', 'workingTreeDiffSha256', 'provenanceRefreshedAt']) delete result[key];
  writeFileSync(resolve(refresh),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({snapshotSha256:frozen,sourceManifestSha256:metadata.sourceManifestSha256,sourceFiles:metadata.sourceFiles.length}));
  process.exit(0);
}
if (supplied) throw new Error('--module is only supported with --refresh-provenance. Timed runs build the selected source.');
let temporary;
let snapshot;
const metadataPath=join(output,`freshness-provenance-${ref?sha256(ref).slice(0,12):'current'}.json`);
try {
  let source = cli;
  if (ref) {
    temporary = mkdtempSync('/private/tmp/aside-freshness-ref-');
    const archive = execFileSync('git',['archive','--format=tar',ref,'cli/src','cli/templates','cli/bench/semantic-fixture.ts'],{cwd:join(cli,'..'),maxBuffer:64*1024*1024});
    execFileSync('tar',['-xf','-','-C',temporary],{input:archive});
    source = join(temporary,'cli');
  }
  snapshot = join(output,`freshness-${ref ? createHash('sha256').update(ref).digest('hex').slice(0,12) : 'current'}.mjs`);
  await bundle(source,snapshot);
  writeFileSync(metadataPath,JSON.stringify(provenance(source))+'\n');
  await build({entryPoints:[join(cli,'bench','semantic-freshness.ts')],outfile:join(output,'semantic-freshness.mjs'),bundle:true,packages:'external',platform:'node',format:'esm',target:'node22.12'});
} finally {if(temporary)rmSync(temporary,{recursive:true,force:true});}
const forwarded=[];
for(let i=0;i<args.length;i++) {if(args[i]==='--module'){i++;continue;}if(args[i].startsWith('--module='))continue;forwarded.push(args[i]);}
const child=spawn(process.execPath,[join(output,'semantic-freshness.mjs'),'--module',snapshot,'--provenance',metadataPath,...forwarded],{cwd:cli,stdio:'inherit'});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
