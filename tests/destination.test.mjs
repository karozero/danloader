import test from 'node:test';
import assert from 'node:assert/strict';
import {writeVideoFile} from '../dist/infrastructure/destination-store.js';

function fakeDirectory(initial={},onWrite){
  const files=new Map(Object.entries(initial));let aborted=0;
  return {files,get aborted(){return aborted;},async getFileHandle(name,{create=false}={}){
    if(!files.has(name)){if(!create)throw new DOMException('Not found','NotFoundError');files.set(name,new Uint8Array());}
    return {async createWritable(){const chunks=[];return {async write(value){chunks.push(value.slice());onWrite?.();},async close(){files.set(name,new Uint8Array(await new Blob(chunks).arrayBuffer()));},async abort(){aborted++;}};}};
  },async removeEntry(name){files.delete(name);}};
}

test('Selected directory receives complete bytes and existing names are preserved',async()=>{
  const original=Uint8Array.of(99),directory=fakeDirectory({'video.mp4':original});
  const data=Uint8Array.from({length:100000},(_,i)=>i%255);
  const result=await writeVideoFile(directory,new Blob([data]),'video.mp4');
  assert.equal(result.filename,'video (1).mp4');assert.equal(result.bytes,data.length);
  assert.deepEqual(directory.files.get('video.mp4'),original);assert.deepEqual(directory.files.get(result.filename),data);
});
test('Cancelling a directory write aborts it and removes its incomplete new file',async()=>{
  const controller=new AbortController(),directory=fakeDirectory({'keep.mp4':Uint8Array.of(9)},()=>controller.abort());
  await assert.rejects(writeVideoFile(directory,new Blob([new Uint8Array(100000)]),'cancelled.mp4',{signal:controller.signal}),{name:'AbortError'});
  assert.equal(directory.aborted,1);assert.deepEqual([...directory.files.keys()],['keep.mp4']);
});
test('Directory destination refuses paths rather than interpreting them as filenames',async()=>{
  const directory=fakeDirectory();
  for(const name of ['../escape.mp4','subdir/file.mp4','subdir\\file.mp4'])await assert.rejects(writeVideoFile(directory,new Blob(['x']),name),/Недопустимое имя/);
  assert.equal(directory.files.size,0);
});
