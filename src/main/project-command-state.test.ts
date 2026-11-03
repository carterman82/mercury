import { expect, it } from 'vitest';
import { commandSnapshot, compareCommandSnapshots } from './project-command-state';

it('selects the same files across reversed asynchronous metadata completion above 64 MB', async () => {
  const paths=Array.from({length:10},(_,i)=>`file-${i}`);
  async function run(reverse:boolean){
    const reads:string[]=[];
    const snapshot=await commandSnapshot('unused',{list:async()=>[...paths].reverse(),stat:async file=>{await new Promise(resolve=>setTimeout(resolve,reverse?10-Number(file.slice(-1)):Number(file.slice(-1))));return {size:8000000,mtimeMs:1}},read:async file=>{reads.push(file);return Buffer.alloc(8000000,Number(file.slice(-1)))}});
    return {snapshot,reads:reads.sort()};
  }
  const a=await run(false),b=await run(true);
  expect(a.snapshot.digest).toBe(b.snapshot.digest);expect(a.reads).toEqual(b.reads);expect(a.reads).toHaveLength(8);
  expect(compareCommandSnapshots(a.snapshot,b.snapshot)).toMatchObject({state:'unknown',changedPaths:[]});
});
it('distinguishes actual source changes and reports bounded paths',async()=>{
  let data=Buffer.from('before');const io={list:async()=>['app.js'],stat:async()=>({size:data.length,mtimeMs:1}),read:async()=>data};
  const before=await commandSnapshot('unused',io);data=Buffer.from('after');const after=await commandSnapshot('unused',io);
  expect(compareCommandSnapshots(before,after)).toEqual({state:'changed',changedPaths:['app.js']});
  expect(compareCommandSnapshots(after,after).state).toBe('unchanged');
});

it.each(['unreadable','unstable','metadata:6:1'])('treats incomplete fingerprint %s as unknown rather than changed', value => {
  const before={digest:'before',complete:true,entries:[{path:'app.js',fingerprint:'a'.repeat(64)}]};
  const after={digest:'after',complete:false,entries:[{path:'app.js',fingerprint:value}]};
  expect(compareCommandSnapshots(before,after)).toEqual({state:'unknown',changedPaths:[]});
  expect(compareCommandSnapshots(after,before)).toEqual({state:'unknown',changedPaths:[]});
});

it('does not infer deletion from a truncated listing', () => {
  const before={digest:'before',complete:true,entries:[{path:'app.js',fingerprint:'a'.repeat(64)}]};
  expect(compareCommandSnapshots(before,{digest:'after',complete:false,entries:[]})).toEqual({state:'unknown',changedPaths:[]});
  expect(compareCommandSnapshots(before,{digest:'after',complete:true,entries:[]})).toEqual({state:'changed',changedPaths:['app.js']});
});
