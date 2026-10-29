import test from 'node:test';
import assert from 'node:assert/strict';
import {observeResponse,sabrPercent} from '../dist/core/network-progress.js';
test('Network observation reports chunks before completion and preserves HTTP range metadata',async()=>{
 let stream;const received=[];
 const response=new Response(new ReadableStream({start(c){stream=c;}}),{status:206,headers:{'Content-Range':'bytes 0-3/10','Content-Length':'4'}});
 Object.defineProperty(response,'url',{value:'https://cdn.test/video.mp4'});
 const observed=observeResponse(response,bytes=>received.push(bytes)),reader=observed.body.getReader();
 stream.enqueue(Uint8Array.of(1,2));assert.deepEqual((await reader.read()).value,Uint8Array.of(1,2));assert.deepEqual(received,[2]);
 assert.equal(observed.status,206);assert.equal(observed.headers.get('Content-Range'),'bytes 0-3/10');assert.equal(observed.url,response.url);
 stream.enqueue(Uint8Array.of(3,4));stream.close();assert.deepEqual((await reader.read()).value,Uint8Array.of(3,4));assert.equal((await reader.read()).done,true);assert.deepEqual(received,[2,2]);
});
test('SABR progress uses both track lengths or their shared downloaded timeline',()=>{
 assert.equal(sabrPercent({bytes:25,totalBytes:100}),25);
 assert.equal(sabrPercent({duration:4,videoEnd:3000,audioEnd:1000}),25);
 assert.equal(sabrPercent({duration:4,videoEnd:3000,audioEnd:2000}),50);
 assert.equal(sabrPercent({duration:0}),null);
});
