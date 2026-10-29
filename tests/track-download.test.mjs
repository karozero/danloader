import test from 'node:test';
import assert from 'node:assert/strict';
import {downloadTracks} from '../dist/application/download-tracks.js';
test('Static tracks start concurrently, concatenate ordered pieces and report live progress',async()=>{
 const started=[],video=[],audio=[],progress=[];let open;
 const gate=new Promise(resolve=>open=resolve);
 const operation=downloadTracks({tracks:{video:['init','video'],audio:['audio']},fetcher:async url=>{started.push(url);await gate;return new Response(Uint8Array.of(url==='init'?1:url==='video'?2:3),{headers:{'Content-Length':'1'}});},sinks:{video:chunk=>video.push(...chunk),audio:chunk=>audio.push(...chunk)},onProgress:(bytes,percent)=>progress.push({bytes,percent})});
 await Promise.resolve();assert.deepEqual(started,['init','audio']);open();await operation;assert.deepEqual(video,[1,2]);assert.deepEqual(audio,[3]);assert.ok(progress.some(p=>p.bytes>0&&p.percent<99));
});
test('A partial byte-range response cannot be saved as a complete static track',async()=>{
 await assert.rejects(downloadTracks({tracks:{video:['v'],audio:['a']},fetcher:async()=>new Response('piece',{status:206,headers:{'Content-Range':'bytes 5-9/100'}}),sinks:{video(){},audio(){}}}),/диапазон/);
});
