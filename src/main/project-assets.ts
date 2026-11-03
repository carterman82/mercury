/** Fixed host script, run under the same project confinement as other processes.
 * URL and path data are JSON literals; no shell parsing or model-generated code. */
export function projectAssetScript(input: { url: string; destination: string; format: 'json' | 'gguf' | 'wasm' | 'binary'; maxBytes: number; sha256?: string; temporary?: string }) {
  return `const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const config=${JSON.stringify(input)};
const timer=AbortSignal.timeout(120000);
let temporary;
function fail(code,message){throw Object.assign(new Error(message),{code})}
function url(value){const parsed=new URL(value);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)fail('ASSET_URL','Asset URL must be HTTP(S) without credentials.');return parsed}
(async()=>{
let current=url(config.url),response;
for(let redirects=0;redirects<=5;redirects++){
 response=await fetch(current,{redirect:'manual',signal:timer});
 if(response.status>=300&&response.status<400){const location=response.headers.get('location');await response.body?.cancel();if(!location||redirects===5)fail('ASSET_REDIRECT','Asset redirect limit exceeded.');current=url(new URL(location,current));continue}break;
}
if(!response.ok){await response.body?.cancel();fail('ASSET_HTTP','Asset returned HTTP '+response.status)}
if(Number(response.headers.get('content-length'))>config.maxBytes){await response.body?.cancel();fail('ASSET_TOO_LARGE','Asset exceeds declared byte limit.')}
const parent=path.dirname(config.destination);
await fs.mkdir(parent,{recursive:true});
const canonical=await fs.realpath(parent),same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
if(!same(canonical,path.resolve(parent)))fail('ASSET_PATH_CHANGED','Asset parent changed before download.');
temporary=config.temporary??path.join(parent,'.'+path.basename(config.destination)+'.'+crypto.randomUUID()+'.download');
const file=await fs.open(temporary,'wx');let bytes=0;const digest=crypto.createHash('sha256');
try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>config.maxBytes)fail('ASSET_TOO_LARGE','Asset exceeds declared byte limit.');digest.update(chunk);await file.writeFile(chunk)}}finally{await file.close()}
if(!bytes)fail('ASSET_EMPTY','Asset is empty.');
const head=await fs.open(temporary,'r');const prefix=Buffer.alloc(Math.min(512,bytes));try{await head.read(prefix,0,prefix.length,0)}finally{await head.close()}
if(/^\\s*(?:<!doctype html|<html|<error>|Entry not found|Internal server error)/i.test(prefix.toString('utf8')))fail('ASSET_FORMAT','Downloaded an error page instead of an asset.');
if(config.format==='json'){if(bytes>8000000)fail('ASSET_FORMAT','JSON validation is limited to 8 MB.');try{JSON.parse(await fs.readFile(temporary,'utf8'))}catch{fail('ASSET_FORMAT','Downloaded metadata is not valid JSON.')}}
if(config.format==='gguf'&&(bytes<8||prefix.subarray(0,4).toString('ascii')!=='GGUF'))fail('ASSET_FORMAT','Downloaded model has no GGUF signature.');
if(config.format==='wasm'&&!prefix.subarray(0,4).equals(Buffer.from([0,97,115,109])))fail('ASSET_FORMAT','Downloaded module has no WASM signature.');
const sha256=digest.digest('hex');if(config.sha256&&sha256!==config.sha256)fail('ASSET_HASH','Downloaded asset hash does not match.');
if(!same(await fs.realpath(parent),canonical))fail('ASSET_PATH_CHANGED','Asset parent changed before replacement.');
await fs.rename(temporary,config.destination);temporary=undefined;
console.log(JSON.stringify({url:current.href,status:response.status,bytes,sha256,format:config.format,validated:true}));
})().catch(async error=>{if(temporary)await fs.rm(temporary,{force:true}).catch(()=>{});console.error(JSON.stringify({error:error.message,code:typeof error.code==='string'?error.code:'ASSET_DOWNLOAD'}));process.exitCode=1});`;
}
