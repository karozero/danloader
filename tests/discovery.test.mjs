import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {visibleMedia,manifestReferences,segmentUrl,thumbnailUrl,durationText} from '../dist/core/discovery.js';
import {mediaKind} from '../dist/core/media.js';
const pageUrl='https://boosty.to/author/posts/post';
const media=(url,kind='file',extra={})=>({url:'https://cdn.test/'+url,kind,source:'network',pageUrl,frameId:0,...extra});

test('Two player IDs remain two videos despite qualities and arbitrary 1MB fragments',()=>{
  const groups=[1,2].map(i=>media(`v${i}.mp4`,'file',{groupId:'boosty:'+i,duration:i===1?4493:2083,entries:[{url:`https://cdn.test/v${i}.mp4`,kind:'file'},{url:`https://cdn.test/v${i}.m3u8`,kind:'hls'}]}));
  const segments=Array.from({length:80},(_,i)=>media('opaque-'+i+'.mp4','file',{size:1048576}));
  const values=[...groups,...segments,media('v1.mp4','file',{size:200000000}),media('v1.m3u8','hls'),media('v2.m3u8','hls')];
  assert.deepEqual(visibleMedia(values),groups);
  assert.equal(durationText(groups[0].duration),'1:14:53');assert.equal(durationText(groups[1].duration),'34:43');
});
test('Manifest membership hides large and extensionless segments, regardless of arrival order',()=>{
  const root=media('master.m3u8','hls',{manifestText:'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant.m3u8\n'});
  const variant=media('variant.m3u8','hls',{manifestText:'#EXTM3U\n#EXTINF:10,\nopaque?id=123\n#EXT-X-ENDLIST'});
  const chunk=media('opaque?id=123','file',{size:40000000});
  assert.deepEqual(visibleMedia([chunk,variant,root]),[root]);
});
test('Small explicit page video and HTTP byte ranges are not hidden by a blanket size threshold',()=>{
  const video=media('small.mp4','file',{source:'DOM',size:12000});
  assert.deepEqual(visibleMedia([video]),[video]);
  assert.deepEqual(visibleMedia([media('full.mp4','file',{size:60000000})]).map(m=>m.url),['https://cdn.test/full.mp4']);
  assert.equal(mediaKind('https://cdn.test/audio.mp4','audio/mp4'),'audio');
});
test('Segments from another frame do not make unrelated videos disappear',()=>{
  const root=media('main.mpd','dash',{frameId:1});
  const video=media('other.mp4','file',{size:1000000,frameId:2});
  assert.deepEqual(visibleMedia([root,video]),[root,video]);
});
test('DASH SegmentTemplate references recognize init and numbered media URLs',()=>{
  const root=media('mpd/main.mpd','dash',{manifestText:'<MPD><BaseURL>https://cdn.test/video/</BaseURL><Period><AdaptationSet><SegmentTemplate initialization="init-$RepresentationID$.mp4" media="part-$Number%05d$.mp4"/></AdaptationSet></Period></MPD>'});
  const refs=manifestReferences(root);
  assert.ok(refs.patterns.some(p=>new RegExp(p).test('https://cdn.test/video/part-00042.mp4')));
  assert.deepEqual(visibleMedia([root,media('video/part-00042.mp4','file',{size:30000000})]),[root]);
});
test('Initialization fragments and image URL schemes are validated',()=>{
  for(const url of ['https://cdn.test/init.mp4','https://cdn.test/chunk-123.mp4','https://cdn.test/frag_42.m4v','https://cdn.test/a.m4s'])assert.equal(segmentUrl(url),true,url);
  assert.equal(segmentUrl('https://cdn.test/my-holiday.mp4'),false);
  assert.equal(thumbnailUrl('javascript:alert(1)'),null);
  assert.equal(thumbnailUrl('data:image/svg+xml;base64,PHN2Zz4='),null);
  assert.equal(thumbnailUrl('data:image/png;base64,AAAA'),'data:image/png;base64,AAAA');
});
test('Boosty player adapter observes whole videos and calls the original initPlayer unchanged',async()=>{
  const messages=[],registry=new Map();let originalCalls=0;
  const document={title:'Two Boosty videos',querySelectorAll:()=>[],scripts:[]};
  const window={postMessage:m=>messages.push(m),addEventListener:()=>{},fetch:()=>Promise.resolve(new Response(''))};
  const customElements={get:name=>registry.get(name),whenDefined:()=>new Promise(()=>{}),define:(name,ctor)=>registry.set(name,ctor)};
  class XHR {open(){} addEventListener(){}}
  const context={window,document,customElements,XMLHttpRequest:XHR,location:{href:pageUrl,origin:'https://boosty.to',hostname:'boosty.to'},URL,Response,TextDecoder,Map,JSON,Reflect,console};
  vm.runInNewContext(fs.readFileSync(new URL('../dist/page.js',import.meta.url),'utf8'),context);
  class Player {initPlayer(config){originalCalls++;return config.videos.length;}}
  customElements.define('vk-video-player',Player);
  const config={videos:[{unitedVideoId:'first',title:'First',duration:4493,thumbUrl:'https://cdn.test/1.jpg',sources:{MPEG:{'720p':'https://cdn.test/first.mp4'},HLS:{url:'https://cdn.test/first.m3u8'}}},{unitedVideoId:'second',title:'Second',duration:2083,thumbUrl:'https://cdn.test/2.jpg',sources:{DASH_SEP:{url:'https://cdn.test/second.mpd'}}}]};
  assert.equal(new Player().initPlayer(config),2);assert.equal(originalCalls,1);
  const videos=messages.flatMap(m=>m.media||[]);
  assert.equal(videos.length,2);assert.equal(videos[0].entries.length,2);assert.equal(videos[1].duration,2083);assert.equal(videos[0].thumbnail,'https://cdn.test/1.jpg');
  assert.deepEqual(Object.keys(config),['videos']);
});
