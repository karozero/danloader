import test from 'node:test';import assert from 'node:assert/strict';
import {staticHlsTrack} from '../dist/core/hls-static.js';
import {downloadHls} from '../dist/application/download-hls.js';
const vod='#EXTM3U\n#EXTINF:6,\nfirst.ts?signature=keep\n#EXTINF:4,\nsecond.ts\n#EXT-X-ENDLIST';
test('Static HLS preserves signed segment URLs, initialization order and exact playlist duration',()=>{
 const plan=staticHlsTrack(vod,'https://cdn.example.test/path/playlist.m3u8?token=master');
 assert.deepEqual(plan,{pieces:['https://cdn.example.test/path/first.ts?signature=keep','https://cdn.example.test/path/second.ts'],duration:10});
 assert.deepEqual(staticHlsTrack(vod.replace('#EXTINF:6,','#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,'),'https://cdn.example.test/path/list.m3u8').pieces,['https://cdn.example.test/path/init.mp4',...plan.pieces]);
});
test('Live, encrypted, ranged, discontinuous and incomplete HLS keep the general loader',()=>{
 for(const text of [vod.replace('#EXT-X-ENDLIST',''),vod.replace('#EXTINF:6,','#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:6,'),vod.replace('#EXTINF:6,','#EXT-X-BYTERANGE:100@0\n#EXTINF:6,'),vod.replace('#EXTINF:4,','#EXT-X-DISCONTINUITY\n#EXTINF:4,'),vod.replace('first.ts?signature=keep','javascript:bad'),vod.replace('second.ts',''),vod.replace('#EXTINF:4,','#EXT-X-GAP\n#EXTINF:4,')])assert.equal(staticHlsTrack(text,'https://cdn.example.test/list.m3u8'),undefined,text);
});
function memorySpools(){const disposed=[];return {disposed,createSpool:async id=>{let chunks=[];return {reset(){chunks=[];},write(chunk){chunks.push(chunk.slice());},*chunks(){yield*chunks;},async dispose(){disposed.push(id);}};}};}

test('HLS uses at most four active downloads and writes every byte in playlist order despite out-of-order responses',async()=>{
 const spools=memorySpools(),outputs={video:[],audio:[]},progress=[],completed=[];let active=0,peak=0;
 const fetcher=async(url,signal)=>{const index=Number(url);active++;peak=Math.max(peak,active);return new Response(new ReadableStream({start(controller){const timer=setTimeout(()=>{controller.enqueue(new Uint8Array([index,index]));controller.close();active--;completed.push(index);},(4-index%4)*3);signal.addEventListener('abort',()=>clearTimeout(timer),{once:true});}}),{headers:{'content-length':'2'}});};
 const bytes=await downloadHls({video:{pieces:['0','1','2','3','4','5','6','7'],duration:48},audio:{pieces:['8','9'],duration:48}},{...spools,fetcher,sinks:{video:chunk=>outputs.video.push(...chunk),audio:chunk=>outputs.audio.push(...chunk)},onProgress:(bytes,percent)=>progress.push({bytes,percent})});
 assert.equal(peak,4);assert.equal(active,0);assert.notDeepEqual(completed.slice(0,4),[0,1,2,3]);
 assert.deepEqual(outputs.video,[0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7]);assert.deepEqual(outputs.audio,[8,8,9,9]);assert.equal(bytes,20);assert.equal(progress.at(-1).percent,99);assert.equal(spools.disposed.length,4);
 assert.ok(progress.every((value,index)=>!index || value.bytes>=progress[index-1].bytes && value.percent>=progress[index-1].percent));
});

test('A failed HLS segment aborts outstanding reads and disposes every spool without writing an incomplete batch',async()=>{
 const spools=memorySpools();let writes=0,cancelled=0;
 const fetcher=async(url,signal)=>url==='fail'?new Response('denied',{status:403}):new Response(new ReadableStream({start(controller){signal.addEventListener('abort',()=>controller.error(signal.reason),{once:true});},cancel(){cancelled++;}}));
 await assert.rejects(()=>downloadHls({video:{pieces:['wait','fail','wait2','wait3'],duration:24}},{...spools,fetcher,sinks:{video:()=>writes++}}),/сегмент HLS/);
 assert.equal(writes,0);assert.equal(spools.disposed.length,4);
});

test('HLS refuses partial ranges and truncated segment bodies instead of silently saving a short video',async()=>{
 for(const response of [new Response(new Uint8Array([1,2]),{status:206,headers:{'content-range':'bytes 4-5/10'}}),new Response(new Uint8Array([1,2]),{headers:{'content-length':'10'}})]){
  const spools=memorySpools();let wrote=false;
  await assert.rejects(()=>downloadHls({video:{pieces:['one'],duration:6}},{...spools,fetcher:async()=>response,sinks:{video:()=>wrote=true}}),/неполн|не полностью/);
  assert.equal(wrote,false);assert.equal(spools.disposed.length,1);
 }
});
