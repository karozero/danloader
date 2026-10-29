import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceForUrl,getDownloadService} from '../dist/services/registry.js';
import {createDownloadEngine} from '../dist/application/download-engine.js';
import {prepareQueuedYouTube} from '../dist/services/youtube/downloader.js';
const video=(fields={})=>({id:'media',url:'https://cdn.example.test/video.mp4',kind:'file',...fields});
const engine=()=>createDownloadEngine({loadManifest:async(_url,inline)=>{if(!inline)throw new Error('Unexpected network read');return inline;},prepareUrls:async()=>{}});

test('Service routing recognizes actual hosts and rejects lookalike URLs and credential-bearing URLs',()=>{
 for(const[url,id]of [['https://www.youtube.com/watch?v=JPHT9AvoPSA','youtube'],['https://youtu.be/JPHT9AvoPSA','youtube'],['https://www.youtube-nocookie.com/embed/JPHT9AvoPSA','youtube'],['https://www.instagram.com/reel/example/','instagram'],['https://boosty.to/author/posts/example','boosty'],['https://youtube.com.evil.test/','generic'],['https://notinstagram.com/','generic'],['https://user:password@youtube.com/','generic'],['file:///youtube.com/video.mp4','generic'],['invalid','generic']])assert.equal(serviceForUrl(url).id,id,url);
});

test('A page URL selects its service before a conflicting candidate label; iframe and retained CDN ownership survive',()=>{
 assert.equal(getDownloadService(video({servicePageUrl:'https://instagram.com/reel/a/',provider:'youtube'})).id,'instagram');
 assert.equal(getDownloadService(video({pageUrl:'https://youtube.com/embed/JPHT9AvoPSA',servicePageUrl:'https://example.test/article'})).id,'youtube');
 assert.equal(getDownloadService(video({pageUrl:'https://player.example.test/embed',servicePageUrl:'https://boosty.to/author'})).id,'boosty');
 assert.equal(getDownloadService(video({provider:'instagram',groupId:'instagram:retained'})).id,'instagram');
 assert.equal(getDownloadService(video()).id,'generic');
});

test('YouTube URL dispatch preserves the chosen native SABR video and audio instead of treating it as a file',async()=>{
 const media=video({pageUrl:'https://youtube.com/watch?v=JPHT9AvoPSA',kind:'youtube',duration:123,entries:[{kind:'sabr',url:'https://youtube.com/watch?v=JPHT9AvoPSA',formatId:'137',label:'1080p',sabrVideo:{itag:137},sabrAudio:{itag:140}}]});
 const plan=await engine().download(media,0);
 assert.equal(plan.media.kind,'sabr');assert.equal(plan.media.hasAudio,true);assert.equal(plan.duration,123);assert.equal(plan.variant.sabrVideo.itag,137);assert.equal(plan.variant.sabrAudio.itag,140);
});

test('Instagram URL dispatch groups duplicate encodings, keeps the chosen quality and downloads complete paired tracks',async()=>{
 const media=video({pageUrl:'https://instagram.com/reel/example/',provider:'instagram',entries:[{kind:'pair',url:'https://cdn.example.test/low.mp4',audioUrl:'https://cdn.example.test/audio.mp4',width:640,height:360,label:'360p'},{kind:'pair',url:'https://cdn.example.test/high.mp4',audioUrl:'https://cdn.example.test/audio.mp4',width:1280,height:720,bitrate:2000000,label:'720p'},{kind:'pair',url:'https://cdn.example.test/duplicate.mp4',audioUrl:'https://cdn.example.test/audio.mp4',width:1280,height:720,bitrate:1000000,label:'720p'}]});
 const download=engine(),qualities=await download.inspect(media);
 assert.deepEqual(qualities.variants.map(v=>v.label),['720p','360p']);
 const high=await download.download(media,0),low=await download.download(media,1);
 assert.equal(high.media.kind,'tracks');assert.equal(high.media.hasAudio,true);assert.deepEqual(high.variant.tracks,{video:['https://cdn.example.test/high.mp4'],audio:['https://cdn.example.test/audio.mp4']});
 assert.deepEqual(low.variant.tracks.video,['https://cdn.example.test/low.mp4']);
});

test('Boosty URL dispatch preserves the selected grouped full-file quality and video identity',async()=>{
 const media=video({servicePageUrl:'https://boosty.to/author/posts/id',groupId:'boosty:first-video',duration:4493,entries:[{kind:'file',url:'https://cdn.example.test/360.mp4',label:'360p'},{kind:'file',url:'https://cdn.example.test/720.mp4',label:'720p'}]});
 const plan=await engine().download(media,1);
 assert.equal(plan.media.groupId,'boosty:first-video');assert.equal(plan.variant.url,'https://cdn.example.test/720.mp4');assert.equal(plan.duration,4493);assert.equal(plan.media.kind,'file');
});

test('YouTube queue refresh retains the selected format ID when qualities reorder and retries a 403 only once',async()=>{
 const request={media:video({provider:'youtube',videoId:'JPHT9AvoPSA'}),formatId:'137',selection:0,container:'mp4'},forces=[],probed=[];
 const context={refreshMedia:async(media,force)=>{forces.push(force);return {...media,entries:[{formatId:'140',url:'https://cdn.example.test/audio'},{formatId:'137',url:'https://cdn.example.test/video-'+force}]};},configureHeaders:async()=>{},probe:async entry=>{probed.push(entry.url);if(probed.length===1)throw Object.assign(new Error('expired'),{status:403});}};
 await prepareQueuedYouTube(request,context);
 assert.deepEqual(forces,[false,true]);assert.equal(request.selection,1);assert.deepEqual(probed,['https://cdn.example.test/video-false','https://cdn.example.test/video-true']);
 await assert.rejects(()=>prepareQueuedYouTube(request,{...context,probe:async()=>{throw Object.assign(new Error('still forbidden'),{status:403});}}),/still forbidden/);
 assert.deepEqual(forces,[false,true,false,true]);
});

test('Every service rejects protected, cancelled and missing-quality downloads before starting a worker',async()=>{
 for(const pageUrl of ['https://youtube.com/','https://instagram.com/','https://boosty.to/','https://example.test/']){
  const download=engine();
  await assert.rejects(()=>download.download(video({pageUrl,drm:true})),/DRM/);
  await assert.rejects(()=>download.download(video({pageUrl}),0,AbortSignal.abort()),{name:'AbortError'});
  await assert.rejects(()=>download.download(video({pageUrl}),99),/качество/);
 }
});

test('Refreshing a grouped signed URL never reuses a previously expanded quality projection',async()=>{
 const download=engine(),media=video({pageUrl:'https://boosty.to/author',entries:[{kind:'file',label:'720p',url:'https://cdn.example.test/video.mp4?token=old'}]});
 await download.inspect(media);assert.equal((await download.download(media)).variant.url,media.entries[0].url);
 const fresh={...media,entries:[{...media.entries[0],url:'https://cdn.example.test/video.mp4?token=new'}]};
 await download.inspect(fresh);assert.equal((await download.download(fresh)).variant.url,fresh.entries[0].url);
});

test('A complete native file on a YouTube page remains downloadable without a logical player ID',async()=>{
 const service=serviceForUrl('https://youtube.com/'),media=video({pageUrl:'https://youtube.com/',url:'https://cdn.example.test/complete.mp4'});
 assert.equal(await service.refresh(media,false,{readPlayer:()=>{throw new Error('Unexpected player request');},observed:[],onChange(){}}),media);
 await service.prepareQueued({media,container:'mp4'},{refreshMedia:()=>{throw new Error('Unexpected refresh');},configureHeaders:async()=>{}});
 assert.equal((await engine().download(media)).variant.url,media.url);
});
