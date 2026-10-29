import test from 'node:test';
import assert from 'node:assert/strict';
import {instagramQualities} from '../dist/services/instagram/qualities.js';
import {createQualityCache} from '../dist/application/quality-cache.js';
test('Instagram offers one best encoding per resolution, labels portrait by short edge and retains 60fps',()=>{
 const variants=instagramQualities([{url:'low',width:720,height:1280,bitrate:100,mime:'video/mp4; codecs="avc1"'},{url:'best',width:720,height:1280,bitrate:500,mime:'video/mp4; codecs="avc1"'},{url:'vp9',width:720,height:1280,bitrate:900,mime:'video/webm'},{url:'small',width:360,height:640},{url:'fast',width:720,height:1280,fps:'60/1'}]);
 assert.deepEqual(variants.map(v=>v.label),['720p · 60 fps','720p','360p']);assert.equal(variants[1].url,'best');
});
test('Hanging quality inspections end in a retryable error instead of loading forever',async()=>{
 let changes=0;const cache=createQualityCache(()=>new Promise(()=>{}),{timeoutMs:10,onChange:()=>changes++});
 await assert.rejects(cache.resolve('id',1),/повторной/);assert.equal(cache.get('id',1).status,'error');assert.equal(changes,1);
});
test('A late result cannot overwrite new metadata and a retry can recover',async()=>{
 const pending=[];let changes=0;const cache=createQualityCache(()=>new Promise(resolve=>pending.push(resolve)),{onChange:()=>changes++});
 const first=cache.resolve('id',1);await Promise.resolve();const second=cache.resolve('id',2);await Promise.resolve();
 pending[1]({variants:[{label:'720p'}]});await second;pending[0]({variants:[{label:'stale'}]});await first;
 assert.equal(cache.get('id',2).result.variants[0].label,'720p');assert.equal(changes,1);
 const retry=cache.resolve('id',2,true);await Promise.resolve();pending[2]({variants:[{label:'1080p'}]});await retry;assert.equal(cache.get('id',2).result.variants[0].label,'1080p');
});
