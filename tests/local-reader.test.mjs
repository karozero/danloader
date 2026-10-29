import test from 'node:test';
import assert from 'node:assert/strict';
import {cachedFileReader,mountLocalInputs} from '../dist/infrastructure/local-reader.js';
test('Small sequential and random reads reuse aligned blocks without loading an entire file',()=>{
 const bytes=Uint8Array.from({length:2500},(_,i)=>i%251);let calls=0,maxRead=0;
 const handle={read(target,{at}){calls++;maxRead=Math.max(maxRead,target.length);const value=bytes.subarray(at,at+target.length);target.set(value);return value.length;}};
 const read=cachedFileReader(handle,bytes.length,1024);
 for(const at of [0,1,20,999,1023])assert.equal(read(at).data[at-read(at).position],bytes[at]);
 assert.equal(calls,1);assert.equal(read(1024).data[0],bytes[1024]);assert.equal(read(2048).data.length,452);assert.equal(calls,3);
 assert.equal(read(2500).data.length,0);assert.equal(calls,3);assert.equal(read(17).data[17],bytes[17]);assert.equal(calls,4);assert.equal(maxRead,1024);
 assert.throws(()=>read(-1));
});
test('A truncated local input produces an error instead of an endless retry',()=>{
 const read=cachedFileReader({read:()=>0},100);assert.throws(()=>read(0),/прочитать/);
});
test('Mounted local input handles close when initialization fails',async()=>{
 let closed=0;
 const root={getFileHandle:async()=>({getFile:async()=>({size:100}),createSyncAccessHandle:async()=>({close(){closed++;},read(){}})})};
 await assert.rejects(mountLocalInputs({mkblockreaderdev:async()=>{throw Error('mount failed');}},root,[{name:'video',file:'video'}]),/mount failed/);assert.equal(closed,1);
});
