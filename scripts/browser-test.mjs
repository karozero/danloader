import {staticHlsTrack} from '../dist/core/hls-static.js';
import {launch} from './cdp.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {loopFragmentedMp4} from '../tests/fixtures/fragmented-loop.mjs';
import {videoId as sabrVideoId,video as sabrVideo,audio as sabrAudio,nativeBody,mediaResponse} from '../tests/fixtures/sabr.mjs';
const root=path.resolve(import.meta.dirname,'..'), fixtures=new Map(), requests=[];
const stalledResponses=new Set();
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');requests.push({method:req.method,path:url.pathname,range:req.headers.range});
  if(url.pathname==='/stall.mpd'){stalledResponses.add(res);res.on('close',()=>stalledResponses.delete(res));return;}
  if(url.pathname==='/slow.mp4'){
    res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':100000000});res.write(Buffer.alloc(16384));
    const interval=setInterval(()=>res.write(Buffer.alloc(16384)),100);res.on('close',()=>clearInterval(interval));return;
  }
  if(url.pathname==='/fail.mp4'){res.writeHead(403,{'Content-Type':'video/mp4'});res.end('Forbidden');return;}
  if(req.method==='POST'){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    fixtures.set(url.pathname.slice(1),{data:Buffer.concat(chunks),type:req.headers['content-type']||'application/octet-stream'});res.end('OK');return;
  }
  if(['/fixture','/regression','/instagram-regression'].includes(url.pathname)){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><title>Local video fixture</title></head><body><video controls id="video"></video></body></html>');return;}
  const fixture=fixtures.get(url.pathname.slice(1));
  let data,type;
  if(fixture)({data,type}=fixture);
  else{
    const file=path.resolve(root,'dist','.'+url.pathname);
    if(!file.startsWith(path.join(root,'dist')+path.sep)){res.writeHead(404).end();return;}
    try{data=await fs.readFile(file);type=file.endsWith('.wasm')?'application/wasm':file.endsWith('.html')?'text/html':'text/javascript';}catch{res.writeHead(404).end();return;}
  }
  res.setHeader('Content-Type',type);res.setHeader('Accept-Ranges','bytes');
  const deliver=payload=>{if(!url.searchParams.has('pace')){res.end(payload);return;}let offset=0;const step=Math.max(1,Math.ceil(payload.length/10));const timer=setInterval(()=>{if(offset>=payload.length){clearInterval(timer);res.end();return;}res.write(payload.subarray(offset,offset+step));offset+=step;},100);res.on('close',()=>clearInterval(timer));};
  const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');
  if(range){const start=Number(range[1]),end=Math.min(data.length-1,range[2]?Number(range[2]):data.length-1);if(start> end){res.writeHead(416).end();return;}res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${data.length}`,'Content-Length':end-start+1});deliver(data.subarray(start,end+1));}
  else{res.setHeader('Content-Length',data.length);deliver(data);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
let browser;const report={cases:[],requests};
try{
  browser=await launch(root);report.browser=browser.version.Browser;
  try { report.loadedExtension=await browser.send('Extensions.loadUnpacked',{path:path.join(root,'dist')});console.log('Loaded extension',report.loadedExtension); } catch(e) {console.log('Extension loader',e.message);report.extensionLoadError=e.message;}
  report.extensionRequests=[];const extensionSessions=new Set();
  browser.on('Target.attachedToTarget',async({sessionId,targetInfo},parentSession)=>{
    if(extensionSessions.has(parentSession)||targetInfo.url.startsWith('chrome-extension://'+report.loadedExtension?.id+'/')){
      extensionSessions.add(sessionId);await browser.send('Network.enable',{},sessionId).catch(()=>{});await browser.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},sessionId).catch(()=>{});
      await browser.send('Runtime.runIfWaitingForDebugger',{},sessionId).catch(()=>{});
    }
  });
  browser.on('Network.requestWillBeSent',(event,session)=>{if(extensionSessions.has(session)&&/^https?:/.test(event.request.url))report.extensionRequests.push({url:event.request.url,method:event.request.method});});
  await browser.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  const {sessionId}=await browser.page(base+'/fixture');
  await new Promise(r=>setTimeout(r,700));
  const targets=await browser.send('Target.getTargets');report.extensionTargets=targets.targetInfos.filter(t=>t.url.startsWith('chrome-extension://')).map(t=>({url:t.url,type:t.type}));
  console.log('Browser',report.browser,'extension targets',report.extensionTargets);
  const supported=await browser.evaluate(sessionId,`['video/mp4;codecs=avc1.42001E,mp4a.40.2','video/mp4','video/webm;codecs=vp8,opus'].map(type=>({type,ok:MediaRecorder.isTypeSupported(type)}))`);console.log('Recorder',supported);
  const fixture=await browser.evaluate(sessionId,`(async()=>{
    const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const ctx=canvas.getContext('2d');
    const stream=canvas.captureStream(15),audio=new AudioContext(),osc=audio.createOscillator(),dest=audio.createMediaStreamDestination();
    osc.connect(dest);osc.start();await audio.resume();stream.addTrack(dest.stream.getAudioTracks()[0]);
    const mime=MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42001E,mp4a.40.2')?'video/mp4;codecs=avc1.42001E,mp4a.40.2':'video/webm;codecs=vp8,opus';
    const recorder=new MediaRecorder(stream,{mimeType:mime}),chunks=[];recorder.ondataavailable=e=>chunks.push(e.data);
    const done=new Promise(resolve=>recorder.onstop=resolve);let n=0;const timer=setInterval(()=>{ctx.fillStyle=n++%2?'#126':'#a82';ctx.fillRect(0,0,160,90);ctx.fillStyle='white';ctx.fillText(String(n),30,40);},65);
    recorder.start();await new Promise(r=>setTimeout(r,2200));recorder.stop();await done;clearInterval(timer);stream.getTracks().forEach(t=>t.stop());osc.stop();await audio.close();
    const blob=new Blob(chunks,{type:mime});await fetch('/source.mp4',{method:'POST',body:blob});return {size:blob.size,mime};
  })()`);console.log('Fixture',fixture);report.fixture=fixture;
  await browser.evaluate(sessionId,`(async()=>{
    globalThis.LibAV={};const {default:create}=await import('/vendor/libav.mjs');globalThis.av=await create({wasmurl:location.origin+'/vendor/libav.wasm'});
    const input=new Uint8Array(await(await fetch('/source.mp4')).arrayBuffer());await av.writeFile('source.mp4',input);
    const hls=await av.ffmpeg('-i','source.mp4','-c','copy','-hls_time','1','-hls_list_size','0','-f','hls','sample.m3u8');
    const video=await av.ffmpeg('-i','source.mp4','-map','0:v:0','-c','copy','-movflags','frag_keyframe+empty_moov+default_base_moof','video.mp4');
    const audio=await av.ffmpeg('-i','source.mp4','-map','0:a:0','-c','copy','-movflags','frag_keyframe+empty_moov+default_base_moof','audio.mp4');
    const candidates=['sample.m3u8','video.mp4','audio.mp4',...Array.from({length:8},(_,i)=>'sample'+i+'.ts')],names=[];
    for(const name of candidates){let data;try{data=await av.readFile(name);}catch{continue;}names.push(name);await fetch('/'+name,{method:'POST',body:data,headers:{'Content-Type':name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':name.endsWith('.mpd')?'application/dash+xml':'application/octet-stream'}});}
    return {hls,video,audio,names};
  })()`).then(value=>{report.generation=value;console.log('Generated',value);});
  assert.equal(report.generation.hls,0);
  function splitMp4(name){
    const data=fixtures.get(name+'.mp4').data;let start=0,offset=0;const segments=[];
    while(offset+8<=data.length){const size=data.readUInt32BE(offset),type=data.toString('ascii',offset+4,offset+8);if(size<8)break;
      if(type==='moof'&&start===0){fixtures.set(name+'-init.mp4',{data:data.subarray(0,offset),type:'video/mp4'});start=offset;}
      if(type==='mdat'&&start){const n=segments.length,filename=name+'-'+n+'.m4s';fixtures.set(filename,{data:data.subarray(start,offset+size),type:'video/mp4'});segments.push(filename);start=offset+size;}
      offset+=size;
    }
    assert.ok(segments.length>0,name+' fragments');return segments;
  }
  const videoSegments=splitMp4('video'),audioSegments=splitMp4('audio');
  const rep=(name,segments,type)=>`<AdaptationSet contentType="${type}" mimeType="${type}/mp4"><Representation id="${name}" bandwidth="300000" ${type==='video'?'width="160" height="90" codecs="avc1.42001e"':'codecs="mp4a.40.2" audioSamplingRate="48000"'}><SegmentList timescale="1000" duration="${Math.round(2200/segments.length)}"><Initialization sourceURL="${name}-init.mp4"/>${segments.map(s=>`<SegmentURL media="${s}"/>`).join('')}</SegmentList></Representation></AdaptationSet>`;
  const mpd=`<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT2.2S" minBufferTime="PT1S"><Period>${rep('video',videoSegments,'video')}${rep('audio',audioSegments,'audio')}</Period></MPD>`;
  fixtures.set('sample.mpd',{data:Buffer.from(mpd),type:'application/dash+xml'});
  const parsed=await browser.evaluate(sessionId,`(async()=>{const {parseDash}=await import('/core/dash.js');const p=parseDash(await(await fetch('/sample.mpd')).text(),location.origin+'/sample.mpd');return {drm:p.drm,count:p.variants.length,text:p.variants[0].manifestText,tracks:p.variants[0].tracks};})()`);
  assert.equal(parsed.count,1);assert.equal(parsed.drm,false);assert.deepEqual(parsed.tracks.video,[base+'/video-init.mp4',...videoSegments.map(name=>base+'/'+name)]);assert.deepEqual(parsed.tracks.audio,[base+'/audio-init.mp4',...audioSegments.map(name=>base+'/'+name)]);
  const longVideo=loopFragmentedMp4(fixtures.get('video.mp4').data,120),longAudio=loopFragmentedMp4(fixtures.get('audio.mp4').data,120);
  const longMedia={duration:Math.min(longVideo.duration,longAudio.duration)};assert.ok(longMedia.duration>200);
  fixtures.set('long-video.mp4',{data:longVideo.data,type:'video/mp4'});fixtures.set('long-audio.mp4',{data:longAudio.data,type:'audio/mp4'});
  fixtures.set('sabr-response-long.bin',{data:mediaResponse(fixtures.get('long-video.mp4').data,fixtures.get('long-audio.mp4').data,{durationMs:Math.round(longMedia.duration*1000)}),type:'application/vnd.yt-ump'});
  fixtures.set('sabr-response.bin',{data:mediaResponse(fixtures.get('video.mp4').data,fixtures.get('audio.mp4').data),type:'application/vnd.yt-ump'});
  for(const spec of [
    {name:'direct',kind:'file',url:base+'/source.mp4'},
    {name:'hls',kind:'hls',url:base+'/sample.m3u8'},
    {name:'hls-fast',kind:'hls',url:base+'/sample.m3u8',hls:{video:staticHlsTrack(fixtures.get('sample.m3u8').data.toString(),base+'/sample.m3u8')}},
    {name:'hls-fmp4-fast',kind:'hls',url:base+'/local-fmp4.m3u8',hls:{video:{pieces:[base+'/video-init.mp4',...videoSegments.map(s=>base+'/'+s)],duration:2.2},audio:{pieces:[base+'/audio-init.mp4',...audioSegments.map(s=>base+'/'+s)],duration:2.2}}},
    {name:'pair',kind:'pair',url:base+'/video.mp4',audioUrl:base+'/audio.mp4'},
    {name:'dash',kind:'dash',url:base+'/sample.mpd',manifestText:parsed.text},
    {name:'sabr',kind:'sabr',url:'https://www.youtube.com/watch?v='+sabrVideoId,videoId:sabrVideoId,sabrVideo,sabrAudio,nativeBody:Buffer.from(nativeBody).toString('base64')},
    {name:'sabr-mkv',kind:'sabr',container:'mkv',url:'https://www.youtube.com/watch?v='+sabrVideoId,videoId:sabrVideoId,sabrVideo,sabrAudio,nativeBody:Buffer.from(nativeBody).toString('base64')},
    {name:'instagram-tracks-long',kind:'tracks',tracks:{video:[base+'/long-video.mp4'],audio:[base+'/long-audio.mp4']},url:base+'/long-video.mp4',duration:longMedia.duration},
    {name:'sabr-long',kind:'sabr',url:'https://www.youtube.com/watch?v='+sabrVideoId,videoId:sabrVideoId,sabrVideo:{...sabrVideo,approxDurationMs:String(Math.round(longMedia.duration*1000))},sabrAudio:{...sabrAudio,approxDurationMs:String(Math.round(longMedia.duration*1000))},nativeBody:Buffer.from(nativeBody).toString('base64'),duration:longMedia.duration}
  ]){
    console.log('Testing worker',spec.name);
    const value=await browser.evaluate(sessionId,`(async()=>{
      const spec=${JSON.stringify(spec)},file='test-'+spec.name+'.'+(spec.container||'mp4'),phases=[];let finalizingAt,finishedAt;
      const result=await new Promise(resolve=>{const worker=new Worker('/worker.js',{type:'module'});const timer=setTimeout(()=>{worker.terminate();resolve({error:'Worker timeout'});},30000);worker.onerror=e=>{clearTimeout(timer);worker.terminate();resolve({error:e.message});};worker.onmessage=async({data})=>{if(data.type==='youtube-media'){let value;if(data.operation==='session')value={url:'https://r.googlevideo.com/videoplayback?id=native',body:spec.nativeBody};else{const response=new Uint8Array(await(await fetch(spec.name==='sabr-long'?'/sabr-response-long.bin':'/sabr-response.bin')).arrayBuffer());let text='';for(let i=0;i<response.length;i+=32768)text+=String.fromCharCode(...response.subarray(i,i+32768));value={body:btoa(text),mime:'application/vnd.yt-ump'};}worker.postMessage({type:'youtube-reply',uid:data.uid,ok:true,value});return;}if(data.type==='progress'){phases.push({status:data.status,bytes:data.bytes,percent:data.percent});if(data.status==='finalizing'&&!finalizingAt)finalizingAt=performance.now();}if(data.type==='done'||data.type==='error'){finishedAt=performance.now();clearTimeout(timer);worker.terminate();resolve(data);}};worker.postMessage({type:'start',file,media:{kind:spec.kind,url:spec.url,videoId:spec.videoId,hasAudio:['sabr','tracks'].includes(spec.kind)?true:undefined},variant:{url:spec.url,audioUrl:spec.audioUrl,manifestText:spec.manifestText,sabrVideo:spec.sabrVideo,sabrAudio:spec.sabrAudio,tracks:spec.tracks,hls:spec.hls},container:spec.container||'mp4',duration:spec.kind==='dash'?null:spec.duration||2.2,live:false});});
      if(result.error)return result;
      const root=await navigator.storage.getDirectory(),output=await(await root.getFileHandle(file)).getFile();const bytes=new Uint8Array(await output.arrayBuffer());await fetch('/result-'+spec.name+'.mp4',{method:'POST',body:bytes});
      await av.writeFile('check.mp4',bytes);const code=await av.ffprobe('-v','quiet','-show_streams','-show_format','-of','json','-o','check.json','check.mp4');
      let probe;try{probe=JSON.parse(new TextDecoder().decode(await av.readFile('check.json')));}catch{}
      await root.removeEntry(file);return {type:result.type,size:bytes.length,code,probe,phases,finalizingMs:finalizingAt?finishedAt-finalizingAt:null};
    })()`);
    console.log(spec.name,JSON.stringify({type:value.type,size:value.size,error:value.error,streams:value.probe?.streams.map(s=>s.codec_type),duration:value.probe?.format.duration}));report.cases.push({name:spec.name,...value});assert.equal(value.type,'done',JSON.stringify(value));assert.ok(value.size>1024);assert.equal(value.code,0);assert.ok(value.probe.streams.some(s=>s.codec_type==='video'));assert.ok(value.probe.streams.some(s=>s.codec_type==='audio'));
  }
  const fastInstagram=report.cases.find(c=>c.name==='instagram-tracks-long');assert.ok(fastInstagram.finalizingMs<15000);assert.ok(Number(fastInstagram.probe.format.duration)>200);
  const longResult=report.cases.find(c=>c.name==='sabr-long');assert.ok(longResult.size>2000000);assert.ok(longResult.finalizingMs<15000,JSON.stringify({finalizingMs:longResult.finalizingMs,size:longResult.size}));
  for(const name of ['sabr','sabr-long']){const item=report.cases.find(c=>c.name===name),phases=item.phases;for(let i=1;i<phases.length;i++)assert.ok(phases[i].bytes>=phases[i-1].bytes,JSON.stringify(phases));const finalizing=phases.findIndex(p=>p.status==='finalizing');assert.ok(finalizing>=0);assert.ok(phases.slice(finalizing).every(p=>p.status==='finalizing'));}
  console.log('Long SABR finalization',{duration:longMedia.duration,bytes:longResult.size,milliseconds:Math.round(longResult.finalizingMs)});
  for(const [name,data]of [['audio-as-video',fixtures.get('audio.mp4').data],['init-as-video',fixtures.get('video-init.mp4').data],['fragment-as-video',fixtures.get(videoSegments[0]).data]]){
    fixtures.set(name+'.mp4',{data,type:'video/mp4'});
    const result=await browser.evaluate(sessionId,`(async()=>{
      const filename=${JSON.stringify('reject-'+name+'.mp4')};
      const result=await new Promise(resolve=>{const w=new Worker('/worker.js',{type:'module'});const timer=setTimeout(()=>{w.terminate();resolve({type:'timeout'});},10000);w.onmessage=({data})=>{if(data.type==='done'||data.type==='error'){clearTimeout(timer);w.terminate();resolve(data);}};w.postMessage({type:'start',file:filename,media:{kind:'file'},variant:{url:location.origin+${JSON.stringify('/'+name+'.mp4')}},container:'mp4'});});
      await(await navigator.storage.getDirectory()).removeEntry(filename).catch(()=>{});return result;
    })()`);
    assert.equal(result.type,'error',JSON.stringify(result));assert.match(result.error,/фрагмент|аудиодорожку/);report.cases.push({name:'Reject HTTP 200 '+name,error:result.error});
  }
  // Generic discovery must work without a domain adapter, including modern open shadow players.
  const genericDiscovery=await browser.evaluate(sessionId,`(async()=>{
    const {discoverHtmlVideos}=await import('/services/generic/discovery.js');
    const previousCrypto=Object.getOwnPropertyDescriptor(crypto,'randomUUID');Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true});
    try {
    const doc=document.implementation.createHTMLDocument('Unknown player'),base=doc.createElement('base');base.href=location.origin+'/';doc.head.append(base);
    const host=doc.createElement('div');doc.body.append(host);const shadow=host.attachShadow({mode:'open'});
    shadow.innerHTML='<video poster="/poster.jpg"><source src="/source.mp4?quality=360" type="video/mp4" label="360p"><source src="/source.mp4?quality=720" type="video/mp4" label="720p"></video>';
    const first=discoverHtmlVideos(doc),second=discoverHtmlVideos(doc);
    const stable=first[0].groupId===second[0].groupId;
    shadow.querySelector('source').src='/another-video.mp4';const changedIdentity=discoverHtmlVideos(doc)[0].groupId!==first[0].groupId;
    shadow.innerHTML='<video src="blob:'+location.origin+'/mse"><source src="/sample.m3u8" type="application/vnd.apple.mpegurl"></video>';
    const blob=discoverHtmlVideos(doc);
    shadow.innerHTML='<video src="javascript:alert(1)"></video>';const unsafe=discoverHtmlVideos(doc);
    const metadata=document.implementation.createHTMLDocument('Metadata only');metadata.head.innerHTML='<base href="'+location.origin+'/"><meta property="og:video" content="/embed.html"><meta property="og:video:type" content="text/html"><script type="application/ld+json">'+JSON.stringify({'@type':'VideoObject',name:'Explicit video',contentUrl:'/source.mp4',duration:'PT3M',thumbnailUrl:'/poster.jpg'})+'<\/script>';
    return {first,stable,changedIdentity,blob,unsafe,metadata:discoverHtmlVideos(metadata)};
    }finally{if(previousCrypto)Object.defineProperty(crypto,'randomUUID',previousCrypto);else delete crypto.randomUUID;}
  })()`);
  assert.equal(genericDiscovery.first.length,1);assert.equal(genericDiscovery.first[0].entries.length,2);assert.equal(genericDiscovery.stable,true);assert.equal(genericDiscovery.changedIdentity,true);assert.deepEqual(genericDiscovery.first[0].entries.map(v=>v.label),['360p','720p']);
  assert.equal(genericDiscovery.blob.length,1);assert.equal(genericDiscovery.blob[0].kind,'hls');assert.equal(genericDiscovery.unsafe.length,0);assert.equal(genericDiscovery.metadata.length,1);assert.equal(genericDiscovery.metadata[0].duration,180);assert.equal(genericDiscovery.metadata[0].title,'Explicit video');
  report.cases.push({name:'Generic HTML fallback finds grouped source qualities in Shadow DOM, ignores unsafe/blob URLs, and reads explicit VideoObject metadata'});
  // Exercise the actual installed extension: discovery -> UI API -> offscreen -> worker -> browser save.
  const extensionId=report.loadedExtension?.id;assert.ok(extensionId,'Extension must be installed in the isolated test profile.');
  const downloadPath=path.join(root,'test-output/downloads');await fs.mkdir(downloadPath,{recursive:true});
  await browser.send('Browser.setDownloadBehavior',{behavior:'default',eventsEnabled:true});
  await browser.evaluate(sessionId,`(async()=>{document.getElementById('video').src='/source.mp4';await fetch('/sample.m3u8');await fetch('/sample.mpd');})()`);
  await new Promise(r=>setTimeout(r,1200));
  const popup=await browser.page('chrome-extension://'+extensionId+'/popup.html');await new Promise(r=>setTimeout(r,400));
  // Keep existing Russian UI assertions independent of the test device locale.
  await browser.evaluate(popup.sessionId,`(async()=>{await chrome.storage.local.set({'danloader.language':'ru'});location.reload();})()`);await new Promise(r=>setTimeout(r,400));
  const fixtureTab=await browser.evaluate(popup.sessionId,`chrome.tabs.query({url:${JSON.stringify(base+'/fixture')}}).then(t=>t[0].id)`);
  const command=async(action,data={})=>browser.evaluate(popup.sessionId,`chrome.runtime.sendMessage(${JSON.stringify({target:'ui',action,tabId:fixtureTab,...data})})`);
  const discovered=await command('list');console.log('Discovered',discovered);assert.equal(discovered.ok,true);assert.ok(discovered.value.media.some(m=>m.kind==='hls'));assert.ok(discovered.value.media.some(m=>m.kind==='dash'));
  for(const kind of ['file','hls','dash']){
    const media=discovered.value.media.find(m=>m.kind===kind && (kind!=='file'||m.url===base+'/source.mp4'));assert.ok(media,kind);
    const inspection=await command('inspect',{id:media.id});console.log('Inspect',kind,inspection);assert.equal(inspection.ok,true,inspection.error);
    if(kind==='file'){
      const host=(await browser.send('Target.getTargets')).targetInfos.find(t=>t.url===`chrome-extension://${extensionId}/offscreen.html`);assert.ok(host);
      const session=(await browser.send('Target.attachToTarget',{targetId:host.targetId,flatten:true})).sessionId;extensionSessions.add(session);
      await browser.send('Network.enable',{},session);await browser.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true},session);
    }
    const started=await command('start',{id:media.id,selection:0,container:'mp4',filename:'e2e-'+kind});console.log('Start',kind,started);assert.equal(started.ok,true,started.error);
    let job;
    for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,250));const list=await command('list');job=list.value.jobs.find(j=>j.id===started.value.id);if(['complete','failed','cancelled'].includes(job.status))break;}
    console.log('E2E',kind,job);report.cases.push({name:'extension-'+kind,...job});assert.equal(job.status,'complete',JSON.stringify(job));
    const saved=await browser.evaluate(popup.sessionId,`chrome.downloads.search({id:${job.browserId}}).then(items=>({filename:items[0].filename,exists:items[0].exists}))`);console.log('Saved',saved);report.cases.at(-1).saved=saved;
    const disk=await fs.stat(saved.filename);assert.ok(disk.size>1024);
  }
  // A page can submit candidates, but cannot issue privileged download commands.
  const specials=[{url:base+'/slow.mp4',kind:'file',title:'Cancellation test'},{url:base+'/fail.mp4',kind:'file',title:'Failure test'},{url:base+'/drm.m3u8',kind:'hls',title:'DRM test'}];
  fixtures.set('drm.m3u8',{data:Buffer.from('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:2,\nsample0.ts\n#EXT-X-ENDLIST'),type:'application/vnd.apple.mpegurl'});
  await browser.evaluate(sessionId,`window.postMessage({channel:'dan-video-candidates',media:${JSON.stringify(specials)}},location.origin)`);await new Promise(r=>setTimeout(r,250));
  const extra=(await command('list')).value.media;
  const drm=await command('inspect',{id:extra.find(m=>m.url===base+'/drm.m3u8').id});assert.equal(drm.ok,false);assert.match(drm.error,/DRM/);report.cases.push({name:'DRM rejected',result:drm.error});
  const slow=await command('start',{id:extra.find(m=>m.url===base+'/slow.mp4').id,filename:'cancelled'});assert.equal(slow.ok,true);await new Promise(r=>setTimeout(r,500));
  const second=await command('start',{id:extra.find(m=>m.url===base+'/source.mp4').id,filename:'queued-cancel'});assert.equal(second.ok,true);assert.equal(second.value.status,'queued');
  assert.equal((await command('cancel',{id:second.value.id})).ok,true);
  const third=await command('start',{id:extra.find(m=>m.url===base+'/source.mp4').id,filename:'queued-success'});assert.equal(third.value.status,'queued');
  const versions=[];browser.on('ServiceWorker.workerVersionUpdated',event=>versions.push(...event.versions));
  await browser.send('ServiceWorker.enable',{},popup.sessionId);await new Promise(r=>setTimeout(r,500));
  const version=versions.find(v=>v.scriptURL===`chrome-extension://${extensionId}/service.js`&&v.runningStatus==='running');assert.ok(version,'Service worker version');
  await browser.send('ServiceWorker.stopWorker',{versionId:version.versionId},popup.sessionId);await new Promise(r=>setTimeout(r,500));
  const resumed=await command('list');assert.equal(resumed.ok,true);assert.equal(resumed.value.jobs.find(j=>j.id===third.value.id).status,'queued');report.cases.push({name:'Service worker restart retains active task and queue',status:resumed.value.jobs.find(j=>j.id===slow.value.id).status});
  assert.equal((await command('cancel',{id:slow.value.id})).ok,true);const cancelled=(await command('list')).value.jobs.find(j=>j.id===slow.value.id);assert.equal(cancelled.status,'cancelled');
  let queued;for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,200));queued=(await command('list')).value.jobs.find(j=>j.id===third.value.id);if(['complete','failed'].includes(queued.status))break;}
  assert.equal(queued.status,'complete',JSON.stringify(queued));report.cases.push({name:'Cancel active and queued tasks; next queue item completes',status:queued.status});
  const failed=await command('start',{id:extra.find(m=>m.url===base+'/fail.mp4').id,filename:'failure'});assert.equal(failed.ok,true);let failure;
  for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,200));failure=(await command('list')).value.jobs.find(j=>j.id===failed.value.id);if(failure.status==='failed')break;}
  assert.equal(failure.status,'failed');assert.match(failure.error,/403/);report.cases.push({name:'HTTP 403',status:failure.status,error:failure.error});
  fixtures.set('live.m3u8',{data:Buffer.from(fixtures.get('sample.m3u8').data.toString().replace('#EXT-X-ENDLIST','')),type:'application/vnd.apple.mpegurl'});
  await browser.evaluate(sessionId,`fetch('/live.m3u8').then(r=>r.text())`);await new Promise(r=>setTimeout(r,250));
  const liveMedia=(await command('list')).value.media.find(m=>m.url===base+'/live.m3u8');assert.ok(liveMedia);
  const liveJob=await command('start',{id:liveMedia.id,filename:'live-test'});assert.equal(liveJob.ok,true);
  await new Promise(r=>setTimeout(r,3500));assert.equal((await command('stop',{id:liveJob.value.id})).ok,true);
  let recording;for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,250));recording=(await command('list')).value.jobs.find(j=>j.id===liveJob.value.id);if(['complete','failed'].includes(recording.status))break;}
  console.log('Live stop',recording);assert.equal(recording.status,'complete',JSON.stringify(recording));report.cases.push({name:'Live HLS graceful stop',status:recording.status,bytes:recording.bytes});
  const allTargets=(await browser.send('Target.getTargets')).targetInfos;const host=allTargets.find(t=>t.url===`chrome-extension://${extensionId}/offscreen.html`);assert.ok(host);
  const offscreenSession=(await browser.send('Target.attachToTarget',{targetId:host.targetId,flatten:true})).sessionId;
  const temp=await browser.evaluate(offscreenSession,`navigator.storage.getDirectory().then(async root=>{const files=[];for await(const name of root.keys())files.push(name);return files;})`);assert.deepEqual(temp,[]);report.cases.push({name:'OPFS cleanup after success, error and cancel',files:temp});
  const rules=await browser.evaluate(popup.sessionId,`chrome.declarativeNetRequest.getSessionRules()`);assert.deepEqual(rules,[]);report.cases.push({name:'Temporary header rules cleaned',count:rules.length});
  const unexpected=report.extensionRequests.filter(r=>new URL(r.url).origin!==base);assert.deepEqual(unexpected,[]);assert.ok(report.extensionRequests.length>0);report.cases.push({name:'Extension network trace uses only the local fixture origin',requests:report.extensionRequests.length});
  // One reel owns its complete inline MPD and both tracks; range-query playback requests stay hidden.
  const instagramPage=await browser.page(base+'/instagram-regression');await new Promise(r=>setTimeout(r,500));
  const instagramCandidate={url:base+'/inline-instagram.mpd',kind:'dash',provider:'instagram',groupId:'instagram:reel',title:'Instagram reel',duration:2.2,hasAudio:true,manifestText:mpd,
    entries:[{url:base+'/inline-instagram.mpd',kind:'dash',manifestText:mpd,label:'Все качества',formatId:'mpd'}]};
  const igFragments=Array.from({length:16},(_,i)=>({url:`https://scontent.cdninstagram.com/reel.mp4?sig=keep&bytestart=${i*1024}&byteend=${i*1024+1023}`,kind:'file',source:'network'}));
  await browser.evaluate(instagramPage.sessionId,`window.postMessage({channel:'dan-video-candidates',media:${JSON.stringify([instagramCandidate,...igFragments])}},location.origin)`);await new Promise(r=>setTimeout(r,400));
  const instagramTab=await browser.evaluate(popup.sessionId,`chrome.tabs.query({url:${JSON.stringify(base+'/instagram-regression')}}).then(t=>t[0].id)`);
  const instagramCommand=async(action,data={})=>browser.evaluate(popup.sessionId,`chrome.runtime.sendMessage(${JSON.stringify({target:'ui',action,tabId:instagramTab,...data})})`);
  const instagramList=await instagramCommand('list');assert.equal(instagramList.value.media.length,1);
  const igMedia=instagramList.value.media[0],igQualities=await instagramCommand('inspect',{id:igMedia.id});assert.equal(igQualities.ok,true,igQualities.error);assert.equal(igQualities.value.variants[0].label,'90p');
  const igStart=await instagramCommand('start',{id:igMedia.id,selection:0,filename:'instagram-complete'});assert.equal(igStart.ok,true);let igJob;
  for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,200));igJob=(await instagramCommand('list')).value.jobs.find(j=>j.id===igStart.value.id);if(['complete','failed'].includes(igJob.status))break;}
  assert.equal(igJob.status,'complete',JSON.stringify(igJob));
  const igPath=await browser.evaluate(popup.sessionId,`chrome.downloads.search({id:${igJob.browserId}}).then(items=>items[0].filename)`);
  fixtures.set('instagram-output.mp4',{data:await fs.readFile(igPath),type:'video/mp4'});
  const igProbe=await browser.evaluate(sessionId,`(async()=>{await av.writeFile('ig.mp4',new Uint8Array(await(await fetch('/instagram-output.mp4')).arrayBuffer()));await av.ffprobe('-v','quiet','-show_streams','-of','json','-o','ig.json','ig.mp4');return JSON.parse(new TextDecoder().decode(await av.readFile('ig.json'))).streams.map(s=>s.codec_type);})()`);
  assert.ok(igProbe.includes('video')&&igProbe.includes('audio'));report.cases.push({name:'Instagram inline MPD keeps one reel, exposes quality and saves real video plus audio',cards:1,hiddenFragments:igFragments.length,streams:igProbe});
  await browser.send('Target.activateTarget',{targetId:instagramPage.targetId});await browser.send('Page.reload',{},popup.sessionId);await new Promise(r=>setTimeout(r,1400));
  let autoQuality;for(let i=0;i<25;i++){autoQuality=await browser.evaluate(popup.sessionId,`({labels:[...document.querySelectorAll('#media select[aria-label="Качество видео"] option')].map(o=>o.textContent),enabled:!document.querySelector('#media .primary')?.disabled,error:document.getElementById('error').textContent})`);if(autoQuality.labels[0]==='90p')break;await new Promise(r=>setTimeout(r,200));}
  assert.deepEqual(autoQuality.labels,['90p']);assert.equal(autoQuality.enabled,true);
  report.cases.push({name:'Instagram popup automatically resolves manifest qualities before enabling Download',...autoQuality});
  const videoRep=/<Representation id="video"[\s\S]*?<\/Representation>/.exec(mpd)[0];
  const replacement=(id,width,height,bandwidth)=>videoRep.replace('id="video"','id="'+id+'"').replace('width="160"','width="'+width+'"').replace('height="90"','height="'+height+'"').replace('bandwidth="300000"','bandwidth="'+bandwidth+'"');
  const duplicateMpd=mpd.replace(videoRep,[replacement('low',720,1280,100000),replacement('best',720,1280,900000),replacement('again',720,1280,300000),replacement('small',360,640,50000)].join(''));
  const projections=await browser.evaluate(sessionId,`(async()=>{const {parseDash}=await import('/core/dash.js');const parsed=parseDash(${JSON.stringify(duplicateMpd)},location.origin+'/sample.mpd',{uniqueQualities:true});return parsed.variants.map(v=>({label:v.label,ids:[...new DOMParser().parseFromString(v.manifestText,'application/xml').querySelectorAll('AdaptationSet[contentType="video"] Representation')].map(r=>r.id)}));})()`);
  assert.deepEqual(projections,[{label:'720p',ids:['best']},{label:'360p',ids:['small']}]);
  await browser.evaluate(instagramPage.sessionId,`window.postMessage({channel:'dan-video-candidates',media:[${JSON.stringify({...instagramCandidate,manifestText:duplicateMpd,entries:[{...instagramCandidate.entries[0],manifestText:duplicateMpd}]})}]},location.origin)`);
  let updated;
  for(let i=0;i<30;i++){updated=await browser.evaluate(popup.sessionId,`({labels:[...document.querySelectorAll('#media select[aria-label="Качество видео"] option')].map(o=>o.textContent),enabled:!document.querySelector('#media .primary')?.disabled,cards:document.querySelectorAll('#media .card').length})`);if(updated.labels.join(',')==='720p,360p')break;await new Promise(r=>setTimeout(r,200));}
  assert.deepEqual(updated.labels,['720p','360p']);assert.equal(updated.cards,1);assert.equal(updated.enabled,true);
  report.cases.push({name:'Instagram metadata updates refresh the popup automatically and duplicate portrait DASH encodings become one selected variant per quality',...updated,projections});
  const pacedMpd=mpd.replace(/(sourceURL|media)="([^"]+)"/g,(_,key,url)=>key+'="'+url+'?pace=1"');
  await browser.evaluate(instagramPage.sessionId,`window.postMessage({channel:'dan-video-candidates',media:[${JSON.stringify({...instagramCandidate,manifestText:pacedMpd,entries:[{...instagramCandidate.entries[0],manifestText:pacedMpd}]})}]},location.origin)`);await new Promise(r=>setTimeout(r,200));
  const progressiveIgStart=await instagramCommand('start',{id:igMedia.id,selection:0,filename:'instagram-live-progress'});assert.equal(progressiveIgStart.ok,true,progressiveIgStart.error);
  let progressiveIgJob,liveIg;
  for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));progressiveIgJob=(await instagramCommand('list')).value.jobs.find(j=>j.id===progressiveIgStart.value.id);
    if(progressiveIgJob.status==='downloading'&&progressiveIgJob.bytes>0){const view=await browser.evaluate(popup.sessionId,`(()=>{const row=[...document.querySelectorAll('.job')].find(n=>n.textContent.includes('instagram-live-progress'));return row?{text:row.textContent,height:row.querySelector('progress')?.getBoundingClientRect().height}:null;})()`);if(view?.height>0&&!view.text.includes('ожидание данных'))liveIg={bytes:progressiveIgJob.bytes,...view};}
    if(['complete','failed'].includes(progressiveIgJob.status))break;
  }
  assert.equal(progressiveIgJob.status,'complete',JSON.stringify(progressiveIgJob));assert.ok(liveIg,'Instagram live bytes and progress bar must appear before completion');
  report.cases.push({name:'Paced Instagram DASH updates downloaded bytes and a visible progress indicator before the file is complete',...liveIg});
  const stalled={url:base+'/stall.mpd',kind:'dash',groupId:'stall',title:'Stalled manifest'};
  await browser.evaluate(instagramPage.sessionId,`window.postMessage({channel:'dan-video-candidates',media:[${JSON.stringify(stalled)}]},location.origin)`);await new Promise(r=>setTimeout(r,300));
  const stalledItem=(await instagramCommand('list')).value.media.find(m=>m.groupId==='stall');assert.ok(stalledItem);
  const deadline=async(action,data={})=>Promise.race([instagramCommand(action,data),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error(action+' blocked behind preparation')),2500);timer.unref();})]);
  const stalledStart=await deadline('start',{id:stalledItem.id,filename:'must-not-save'});assert.equal(stalledStart.ok,true);
  await new Promise(r=>setTimeout(r,300));assert.ok((await deadline('list')).value.jobs.some(j=>j.id===stalledStart.value.id));
  const anotherTab=await browser.page(base+'/fixture');await new Promise(r=>setTimeout(r,300));
  await browser.send('Target.activateTarget',{targetId:anotherTab.targetId});await browser.send('Page.reload',{},popup.sessionId);await new Promise(r=>setTimeout(r,600));
  const sharedQueue=await browser.evaluate(popup.sessionId,`({jobs:[...document.querySelectorAll('.job-title')].map(n=>n.textContent),buttons:[...document.querySelectorAll('#media .primary')].map(n=>n.textContent),disabledCursor:getComputedStyle(Object.assign(document.body.appendChild(document.createElement('button')),{disabled:true})).cursor})`);
  assert.ok(sharedQueue.jobs.includes('Другая вкладка: must-not-save'));assert.ok(sharedQueue.buttons.every(text=>text==='Скачать'));assert.equal(sharedQueue.disabledCursor,'not-allowed');
  report.cases.push({name:'An active job in another tab is visible and disabled controls do not display a loading cursor',...sharedQueue});
  const following=await deadline('start',{id:igMedia.id,selection:0,filename:'after-stall'});assert.equal(following.ok,true);
  assert.equal((await deadline('cancel',{id:stalledStart.value.id})).ok,true);
  for(const response of stalledResponses)response.end('<invalid/>');
  let recovered;
  for(let i=0;i<70;i++){await new Promise(r=>setTimeout(r,200));recovered=(await deadline('list')).value.jobs.find(j=>j.id===following.value.id);if(['complete','failed'].includes(recovered.status))break;}
  assert.equal(recovered.status,'complete',JSON.stringify(recovered));
  assert.equal((await deadline('list')).value.jobs.find(j=>j.id===stalledStart.value.id).status,'cancelled');
  report.cases.push({name:'Stalled preparation acknowledges queue immediately, allows polling and cancellation, then runs the next job'});

  // Synthetic YouTube page and CDN: exercise all production bridges without contacting YouTube.
  const mockYouTube=await browser.page('about:blank'),mockUrl='https://www.youtube.com/watch?v='+sabrVideoId;
  const mockPlayer={playabilityStatus:{status:'OK'},videoDetails:{videoId:sabrVideoId,title:'Synthetic SABR reel',lengthSeconds:'2.2'},streamingData:{serverAbrStreamingUrl:'https://r.googlevideo.com/videoplayback?id=synthetic',adaptiveFormats:[sabrVideo,sabrAudio]}};
  const mockHtml='<!doctype html><html><head><title>Synthetic SABR</title></head><body><h1>Synthetic SABR fixture</h1><script>window.ytInitialPlayerResponse='+JSON.stringify(mockPlayer)+';window.addEventListener("load",()=>setTimeout(()=>fetch("https://r.googlevideo.com/videoplayback?id=synthetic",{method:"POST",body:Uint8Array.from(atob("'+Buffer.from(nativeBody).toString('base64')+'"),c=>c.charCodeAt(0))}),300));</script></body></html>';
  let mockMediaPosts=0;
  const firstSabrSegment=mediaResponse(fixtures.get('video.mp4').data,fixtures.get('audio.mp4').data,{durationMs:1100,endSegmentNum:2});
  const lastSabrSegment=mediaResponse(Buffer.alloc(0),Buffer.alloc(0),{durationMs:1100,segmentNum:2,endSegmentNum:2,startMs:1100,includeMetadata:false});
  browser.on('Fetch.requestPaused',(event,session)=>{
    if(session!==mockYouTube.sessionId)return;
    const media=new URL(event.request.url).hostname.endsWith('.googlevideo.com');
    const watch=event.request.url===mockUrl;
    if(media&&event.request.method==='POST')mockMediaPosts++;
    const segment=mockMediaPosts<=2?firstSabrSegment:lastSabrSegment;
    const fulfill=()=>browser.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:event.request.method==='OPTIONS'?204:media||watch?200:404,responseHeaders:[{name:'Content-Type',value:media?'application/vnd.yt-ump':'text/html'},{name:'Access-Control-Allow-Origin',value:'https://www.youtube.com'},{name:'Access-Control-Allow-Methods',value:'POST,GET,OPTIONS'},{name:'Access-Control-Allow-Headers',value:'content-type,accept'},{name:'Access-Control-Allow-Credentials',value:'true'}],body:(event.request.method==='OPTIONS'?Buffer.alloc(0):media?segment:Buffer.from(watch?mockHtml:'')).toString('base64')},session).catch(()=>{});
    if(media&&event.request.method==='POST'&&mockMediaPosts===3)setTimeout(fulfill,1400);else fulfill();
  });
  await browser.send('Fetch.enable',{patterns:[{urlPattern:'https://www.youtube.com/*'},{urlPattern:'https://*.googlevideo.com/*'}]},mockYouTube.sessionId);
  await browser.send('Page.navigate',{url:mockUrl},mockYouTube.sessionId);await new Promise(r=>setTimeout(r,1300));
  const mockTab=await browser.evaluate(popup.sessionId,`chrome.tabs.query({url:${JSON.stringify(mockUrl)}}).then(t=>t[0]?.id)`);assert.ok(mockTab);
  const mockCommand=async(action,data={})=>browser.evaluate(popup.sessionId,`chrome.runtime.sendMessage(${JSON.stringify({target:'ui',action,tabId:mockTab,...data})})`);
  let mockItem;
  for(let i=0;i<30;i++){mockItem=(await mockCommand('list')).value.media.find(m=>m.provider==='youtube');if(mockItem?.entries?.length)break;await new Promise(r=>setTimeout(r,200));}
  assert.equal(mockItem?.entries?.[0]?.kind,'sabr',JSON.stringify(mockItem));
  await browser.send('Target.activateTarget',{targetId:mockYouTube.targetId});await browser.send('Page.reload',{},popup.sessionId);await new Promise(r=>setTimeout(r,500));
  const mockButton=await browser.evaluate(popup.sessionId,`({label:document.querySelector('#media .primary')?.textContent,disabled:document.querySelector('#media .primary')?.disabled})`);
  assert.equal(mockButton.label,'Скачать');assert.equal(mockButton.disabled,false);
  const mockStarted=await mockCommand('start',{id:mockItem.id,selection:0,filename:'native-sabr-complete'});assert.equal(mockStarted.ok,true,mockStarted.error);
  let mockJob,sabrProgress;
  for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,200));mockJob=(await mockCommand('list')).value.jobs.find(j=>j.id===mockStarted.value.id);if(mockJob.status==='downloading'&&mockJob.percent>0&&mockJob.percent<100){sabrProgress=await browser.evaluate(popup.sessionId,`(()=>{const row=[...document.querySelectorAll('.job')].find(n=>n.textContent.includes('native-sabr-complete'));return {percent:row?.querySelector('progress')?.value,text:row?.textContent};})()`);}if(['complete','failed'].includes(mockJob.status))break;}
  assert.equal(mockJob.status,'complete',JSON.stringify(mockJob));assert.ok(sabrProgress?.percent>0&&sabrProgress.percent<100,JSON.stringify(sabrProgress));
  report.cases.push({name:'YouTube SABR shows an intermediate percentage in its real popup progress bar',...sabrProgress});
  report.cases.push({name:'Synthetic native YouTube SABR session enables Download and completes the full page/content/service/offscreen/worker pipeline',bytes:mockJob.bytes});
  await browser.send('Target.closeTarget',{targetId:mockYouTube.targetId});

  // A Kinescope iframe on an unrelated parent page; all media is served by our local fixture server.
  const ksUrl='https://kinescope.io/embed/KS_CURRENT',ksParent=await browser.page('about:blank'),ksSessions=new Set([ksParent.sessionId]);
  const rangedPlaylist=(name,segments)=>{let offset=fixtures.get(name+'-init.mp4').data.length;return '#EXTM3U\n#EXT-X-MAP:URI="'+base+'/'+name+'.mp4?sig=keep",BYTERANGE="'+offset+'@0"\n'+segments.map(segment=>{const length=fixtures.get(segment).data.length,line='#EXTINF:'+(2.2/segments.length)+',\n#EXT-X-BYTERANGE:'+length+'@'+offset+'\n'+base+'/'+name+'.mp4?sig=keep\n';offset+=length;return line;}).join('')+'#EXT-X-ENDLIST';};
  fixtures.set('ks-video.m3u8',{data:Buffer.from(rangedPlaylist('video',videoSegments)),type:'application/vnd.apple.mpegurl'});fixtures.set('ks-audio.m3u8',{data:Buffer.from(rangedPlaylist('audio',audioSegments)),type:'application/vnd.apple.mpegurl'});
  const ksMaster='#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,NAME="Original",URI="ks-audio.m3u8?lang=fr"\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=640x360,AUDIO="a"\nks-video.m3u8?quality=360\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=1280x720,AUDIO="a"\nks-video.m3u8?quality=720\n';
  fixtures.set('ks-master.m3u8',{data:Buffer.from(ksMaster),type:'application/vnd.apple.mpegurl'});
  const ksPoster='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const ksConfig={playlist:[{id:'canonical-fixture-ks',title:'Kinescope in Sponsr-style iframe',meta:{url:'https://kinescope.io/KS_CURRENT',duration:2.2},poster:{src:{src:ksPoster}},sources:{hls:{src:base+'/ks-master.m3u8?sig=keep'}}}]};
  const ksHtml='<!doctype html><html><head><title>Kinescope fixture</title></head><body><script>var playerOptions='+JSON.stringify(ksConfig)+';<\/script></body></html>';
  browser.on('Target.attachedToTarget',async({sessionId:child,targetInfo},parent)=>{if(targetInfo.type==='iframe'&&ksSessions.has(parent)){ksSessions.add(child);await browser.send('Fetch.enable',{patterns:[{urlPattern:'https://kinescope.io/*'}]},child);await browser.send('Runtime.runIfWaitingForDebugger',{},child);}});
  browser.on('Fetch.requestPaused',(event,session)=>{if(!ksSessions.has(session))return;browser.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:event.request.url===ksUrl?200:404,responseHeaders:[{name:'Content-Type',value:'text/html'}],body:Buffer.from(event.request.url===ksUrl?ksHtml:'').toString('base64')},session).catch(()=>{});});
  await browser.send('Fetch.enable',{patterns:[{urlPattern:'https://kinescope.io/*'}]},ksParent.sessionId);
  await browser.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true},ksParent.sessionId);
  await browser.send('Page.navigate',{url:base+'/regression'},ksParent.sessionId);await new Promise(r=>setTimeout(r,200));
  await browser.evaluate(ksParent.sessionId,`document.body.innerHTML='<iframe src="'+${JSON.stringify(ksUrl)}+'"></iframe>'`);await new Promise(r=>setTimeout(r,1400));
  const ksTab=await browser.evaluate(popup.sessionId,`chrome.tabs.query({url:${JSON.stringify(base+'/regression')}}).then(t=>t[0].id)`);
  const ksCommand=(action,data={})=>browser.evaluate(popup.sessionId,`chrome.runtime.sendMessage(${JSON.stringify({target:'ui',action,tabId:ksTab,...data})})`);
  let ksMedia;for(let i=0;i<30;i++){ksMedia=(await ksCommand('list')).value.media;if(ksMedia.some(m=>m.provider==='kinescope'))break;await new Promise(r=>setTimeout(r,100));}
  const ksItem=ksMedia.find(m=>m.provider==='kinescope');assert.ok(ksItem,JSON.stringify(ksMedia));assert.equal(ksMedia.length,1);assert.ok(ksItem.frameId>0);assert.equal(ksItem.title,ksConfig.playlist[0].title);
  await browser.send('Target.activateTarget',{targetId:ksParent.targetId});await browser.send('Page.reload',{},popup.sessionId);
  let ksView;for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,100));ksView=await browser.evaluate(popup.sessionId,`({cards:document.querySelectorAll('#media .card').length,poster:document.querySelectorAll('.media-visual img').length,qualities:[...(document.querySelector('#media select')?.options||[])].map(o=>o.textContent),disabled:document.querySelector('#media .primary')?.disabled})`);if(ksView.qualities.includes('720p')&&!ksView.disabled)break;}
  assert.equal(ksView.cards,1);assert.equal(ksView.poster,1);assert.deepEqual(ksView.qualities,['720p','360p']);assert.equal(ksView.disabled,false);
  const ksStarted=await ksCommand('start',{id:ksItem.id,selection:0,filename:'kinescope-range-fixture'});assert.equal(ksStarted.ok,true,ksStarted.error);let ksJob;
  for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,100));ksJob=(await ksCommand('list')).value.jobs.find(j=>j.id===ksStarted.value.id);if(['complete','failed'].includes(ksJob.status))break;}
  assert.equal(ksJob.status,'complete',JSON.stringify(ksJob));const ksFile=await browser.evaluate(popup.sessionId,`chrome.downloads.search({id:${ksJob.browserId}}).then(items=>items[0].filename)`);assert.ok((await fs.stat(ksFile)).size>1024);
  assert.ok(requests.some(r=>r.path==='/video.mp4'&&r.range));assert.ok(requests.some(r=>r.path==='/audio.mp4'&&r.range));
  report.cases.push({name:'Kinescope cross-origin iframe groups one video, renders poster and real qualities, and saves range-based HLS with audio',...ksView,bytes:(await fs.stat(ksFile)).size});
  await browser.send('Target.closeTarget',{targetId:ksParent.targetId});

  // Synthetic Instagram feed: prefetch arrives last, but each card must save its own bytes.
  const currentBytes=fixtures.get('source.mp4').data,nextBytes=Buffer.concat([currentBytes,Buffer.from('0000000c667265654e455854','hex')]);
  fixtures.set('current-identity.mp4',{data:currentBytes,type:'video/mp4'});fixtures.set('next-identity.mp4',{data:nextBytes,type:'video/mp4'});fixtures.set('third-identity.mp4',{data:currentBytes,type:'video/mp4'});
  const reelUrl='https://www.instagram.com/reel/CURRENT123/',reelPage=await browser.page('about:blank');
  const nextRecord={id:'222',caption:{text:'Next in feed'},video_url:base+'/next-identity.mp4',dimensions:{width:720,height:1280}};
  const feedData={items:[nextRecord,{id:'111',code:'CURRENT123',caption:{text:'Current in feed'},video_url:base+'/current-identity.mp4',video_duration:2.2},{id:'333',code:'THIRD123',caption:{text:'Third in feed'},video_url:base+'/third-identity.mp4'}]};
  const unowned='<MPD><Period><BaseURL>'+base+'/next-identity.mp4</BaseURL></Period></MPD>';
  const feedHtml='<!doctype html><html><head><title>Instagram test feed</title></head><body><script type="application/json">'+JSON.stringify(feedData)+'</script><script>window.unowned='+JSON.stringify({video_dash_manifest:unowned})+';window.addEventListener("load",()=>setTimeout(()=>fetch("/graphql/query"),300));</script></body></html>';
  browser.on('Fetch.requestPaused',(event,session)=>{
    if(session!==reelPage.sessionId)return;
    const path=new URL(event.request.url).pathname,scroll=path==='/api/v1/clips/scroll',api=scroll||path==='/graphql/query';
    const body=scroll?JSON.stringify({items:[{id:'444',code:'SCROLLED123',caption:{text:'Scrolled reel'},video_url:base+'/current-identity.mp4'}]}):api?JSON.stringify({data:{media:{...nextRecord,code:'NEXT123'}}}):feedHtml;
    browser.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:api?'application/json':'text/html'}],body:Buffer.from(body).toString('base64')},session).catch(()=>{});
  });
  await browser.send('Fetch.enable',{patterns:[{urlPattern:'https://www.instagram.com/*'}]},reelPage.sessionId);await browser.send('Page.navigate',{url:reelUrl},reelPage.sessionId);await new Promise(r=>setTimeout(r,1400));
  const reelTab=await browser.evaluate(popup.sessionId,`chrome.tabs.query({url:${JSON.stringify(reelUrl)}}).then(t=>t[0]?.id)`);assert.ok(reelTab);
  const reelCommand=async(action,data={})=>browser.evaluate(popup.sessionId,`chrome.runtime.sendMessage(${JSON.stringify({target:'ui',action,tabId:reelTab,...data})})`);
  const reels=(await reelCommand('list')).value.media;assert.equal(reels.length,3,JSON.stringify(reels));assert.equal(reels[0].groupId,'instagram:CURRENT123');assert.equal(reels[0].isCurrent,true);assert.equal(reels[0].url,base+'/current-identity.mp4');assert.ok(reels.some(m=>m.groupId==='instagram:NEXT123'));assert.ok(reels.some(m=>m.groupId==='instagram:THIRD123'));
  await browser.send('Target.activateTarget',{targetId:reelPage.targetId});await browser.send('Page.reload',{},popup.sessionId);await new Promise(r=>setTimeout(r,700));
  const feedView=await browser.evaluate(popup.sessionId,`({cards:document.querySelectorAll('#media .card').length,current:document.querySelector('#media .card')?.dataset.current,title:document.querySelector('#media .card input')?.value,currentBadges:document.querySelectorAll('.current-reel').length})`);
  assert.equal(feedView.cards,3);assert.equal(feedView.current,'true');assert.equal(feedView.title,'Current in feed');assert.equal(feedView.currentBadges,1);
  for(const [code,expected]of [['CURRENT123',currentBytes],['NEXT123',nextBytes]]){
    const selected=reels.find(m=>m.groupId==='instagram:'+code),started=await reelCommand('start',{id:selected.id,selection:0,filename:'identity-'+code});assert.equal(started.ok,true,started.error);let completed;
    for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,100));completed=(await reelCommand('list')).value.jobs.find(j=>j.id===started.value.id);if(['complete','failed'].includes(completed.status))break;}
    assert.equal(completed.status,'complete',JSON.stringify(completed));const filename=await browser.evaluate(popup.sessionId,`chrome.downloads.search({id:${completed.browserId}}).then(items=>items[0].filename)`);assert.deepEqual(await fs.readFile(filename),expected);
  }
  report.cases.push({name:'Instagram keeps three feed reels separate, prioritizes the current one, merges a proven ID alias and saves the exact selected video despite late prefetch',...feedView});
  const retainedIds=reels.map(item=>item.id);
  await browser.evaluate(reelPage.sessionId,`history.pushState({},'', '/reel/SCROLLED123/');document.dispatchEvent(new Event('scroll'));fetch('/api/v1/clips/scroll');true`);
  let scrolled;
  for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,100));scrolled=(await reelCommand('list')).value.media;if(scrolled.length===4&&scrolled[0].groupId==='instagram:SCROLLED123'&&scrolled[0].isCurrent)break;}
  assert.equal(scrolled.length,4,JSON.stringify(scrolled));assert.equal(scrolled[0].groupId,'instagram:SCROLLED123');assert.equal(scrolled[0].isCurrent,true);assert.ok(retainedIds.every(id=>scrolled.some(item=>item.id===id)));
  report.cases.push({name:'Instagram history scrolling discovers the new Reel automatically and preserves existing card identities without manual refresh',cards:scrolled.length,current:scrolled[0].groupId});
  await browser.send('Target.closeTarget',{targetId:reelPage.targetId});

  // Regression: two Boosty-style players, two quality sets and many megabyte/kilobyte responses.
  for(const id of ['first','second']){
    for(const name of ['full.mp4','low.mp4','opaque.mp4'])fixtures.set(id+'/'+name,{data:fixtures.get('source.mp4').data,type:'video/mp4'});
    fixtures.set(id+'/master.m3u8',{data:Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nvariant.m3u8\n'),type:'application/vnd.apple.mpegurl'});
    fixtures.set(id+'/variant.m3u8',{data:Buffer.from('#EXTM3U\n#EXTINF:2.2,\nopaque.mp4?part=0\n#EXT-X-ENDLIST'),type:'application/vnd.apple.mpegurl'});
  }
  const regression=await browser.page(base+'/regression');await new Promise(r=>setTimeout(r,500));
  const setup=await browser.evaluate(regression.sessionId,`(async()=>{
    class Player extends HTMLElement{initPlayer(config){this.playback=config;return true;}}
    customElements.define('vk-video-player',Player);await new Promise(r=>setTimeout(r,50));
    const makePoster=(label,color)=>{const c=document.createElement('canvas');c.width=320;c.height=180;const x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,320,180);x.fillStyle='white';x.font='24px sans-serif';x.fillText(label,30,100);return c.toDataURL('image/png');};
    const configs=[{id:'first',duration:4493,thumbUrl:makePoster('Video 1 / 1:14:53','#165562')},{id:'second',duration:2083,thumbUrl:makePoster('Video 2 / 34:43','#68433e')}];
    for(const c of configs){const p=document.createElement('vk-video-player');document.body.append(p);p.initPlayer({videos:[{unitedVideoId:c.id,title:'Video '+c.id,duration:c.duration,thumbUrl:c.thumbUrl,sources:{MPEG:{'1080p':location.origin+'/'+c.id+'/full.mp4','360p':location.origin+'/'+c.id+'/low.mp4'},HLS:{type:'url',url:location.origin+'/'+c.id+'/master.m3u8'}}}]});}
    for(const c of configs){await fetch('/'+c.id+'/master.m3u8');await fetch('/'+c.id+'/variant.m3u8');for(let i=0;i<12;i++)await fetch('/'+c.id+'/opaque.mp4?part='+i,{headers:{Range:'bytes=0-1023'}});await fetch('/'+c.id+'/full.mp4',{headers:{Range:'bytes=1024-2047'}});}
    return {originalInitPreserved:document.querySelectorAll('vk-video-player')[0].playback.videos.length===1};
  })()`);assert.equal(setup.originalInitPreserved,true);
  await new Promise(r=>setTimeout(r,1200));
  const regressionId=await browser.evaluate(popup.sessionId,`chrome.tabs.query({url:${JSON.stringify(base+'/regression')}}).then(t=>t[0].id)`);
  const regressionCommand=async(action,data={})=>browser.evaluate(popup.sessionId,`chrome.runtime.sendMessage(${JSON.stringify({target:'ui',action,tabId:regressionId,...data})})`);
  const whole=(await regressionCommand('list')).value.media;console.log('Whole videos',whole.map(m=>({title:m.title,duration:m.duration,qualities:m.entries?.length})));
  assert.equal(whole.length,2);assert.deepEqual(whole.map(m=>m.duration).sort((a,b)=>b-a),[4493,2083]);assert.ok(whole.every(m=>m.thumbnail?.startsWith('data:image/png;')));assert.ok(whole.every(m=>m.entries.length===3));
  report.cases.push({name:'Two Boosty player IDs produce two whole-video cards despite 28 partial requests',videos:whole.map(m=>({title:m.title,duration:m.duration,qualities:m.entries.length}))});
  await browser.send('Target.activateTarget',{targetId:popup.targetId});
  const groupDownload=await regressionCommand('start',{id:whole[0].id,selection:1,filename:'grouped-whole-video'});assert.equal(groupDownload.ok,true);let groupJob;
  for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,200));groupJob=(await regressionCommand('list')).value.jobs.find(j=>j.id===groupDownload.value.id);if(['complete','failed'].includes(groupJob.status))break;}
  assert.equal(groupJob.status,'complete',JSON.stringify(groupJob));
  const groupSaved=await browser.evaluate(popup.sessionId,`chrome.downloads.search({id:${groupJob.browserId}}).then(items=>items[0].filename)`);
  assert.deepEqual(await fs.readFile(groupSaved),fixtures.get('source.mp4').data);report.cases.push({name:'Selected grouped quality saves the entire file rather than the last playback byte range',bytes:(await fs.stat(groupSaved)).size});
  await browser.send('Page.reload',{},popup.sessionId);await new Promise(r=>setTimeout(r,800));
  const view=await browser.evaluate(popup.sessionId,`({cards:document.querySelectorAll('#media .card').length,posters:document.querySelectorAll('.media-visual img').length,durations:[...document.querySelectorAll('.duration')].map(e=>e.textContent)})`);
  assert.equal(view.cards,2);assert.equal(view.posters,2);assert.deepEqual(view.durations.sort(),['1:14:53','34:43']);report.cases.push({name:'Popup displays two posters and full durations',...view});
  const compact=await browser.evaluate(popup.sessionId,`(()=>{const card=document.querySelector('#media .card'),image=card.querySelector('.media-visual').getBoundingClientRect(),settings=card.querySelector('.card-settings').getBoundingClientRect(),bottom=card.querySelector('.card-bottom').getBoundingClientRect();return {height:card.getBoundingClientRect().height,jobHeight:document.querySelector('.job').getBoundingClientRect().height,sideBySide:settings.left>image.right,bottomBelow:bottom.top>=image.bottom,previewButtons:document.querySelectorAll('.preview-button').length,videos:document.querySelectorAll('#media video').length,checkboxes:document.querySelectorAll('#media input[type=checkbox]').length,globalLocationAbove:document.querySelector('.save-location').getBoundingClientRect().bottom<card.getBoundingClientRect().top};})()`);
  assert.ok(compact.height<175);assert.ok(compact.jobHeight<45);assert.equal(compact.sideBySide,true);assert.equal(compact.bottomBelow,true);assert.equal(compact.previewButtons,0);assert.equal(compact.videos,0);assert.equal(compact.checkboxes,0);assert.equal(compact.globalLocationAbove,true);report.cases.push({name:'Compact two-column cards have images only and one global save location',...compact});
  const beforeChoosing=(await regressionCommand('list')).value.jobs.length;
  const destinationSession=popup.sessionId;
  const defaultDestination=await browser.evaluate(popup.sessionId,`({downloads:document.querySelector('#browser-destination').getAttribute('aria-pressed'),border:getComputedStyle(document.querySelector('#browser-destination')).borderTopColor})`);
  assert.equal(defaultDestination.downloads,'true');
  assert.equal(await browser.evaluate(popup.sessionId,`document.querySelector('#browser-destination').disabled`),true);assert.equal(defaultDestination.border,'rgb(109, 224, 191)');
  // Headless Chrome has no native OS chooser. Substitute only its return value with a real OPFS handle.
  assert.equal(await browser.evaluate(destinationSession,`typeof window.showDirectoryPicker`),'function');
  await browser.evaluate(destinationSession,`window.showDirectoryPicker=()=>Promise.reject(new DOMException('Cancelled','AbortError'));document.querySelector('#choose-destination').click();`);
  await new Promise(r=>setTimeout(r,150));assert.equal((await regressionCommand('destination')).value.mode,'browser');
  assert.equal(await browser.evaluate(destinationSession,`document.querySelector('#error').hidden`),true);
  await browser.evaluate(destinationSession,`window.showDirectoryPicker=options=>{window.pickerCalls=(window.pickerCalls || 0)+1;window.pickerOptions=options;window.pickerHadGesture=navigator.userActivation.isActive;return navigator.storage.getDirectory().then(root=>root.getDirectoryHandle('chosen-test-folder',{create:true}));};document.querySelector('#choose-destination').click();`);
  let chosen;
  for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,100));chosen=await regressionCommand('destination');if(chosen.value?.mode==='directory')break;}
  assert.equal(chosen.value?.name,'chosen-test-folder');assert.equal(chosen.value?.permission,'granted');
  assert.equal((await regressionCommand('list')).value.jobs.length,beforeChoosing);
  assert.equal(await browser.evaluate(destinationSession,`window.pickerOptions.mode`),'readwrite');
  assert.equal(await browser.evaluate(destinationSession,`window.pickerHadGesture`),true);
  const selectedId=chosen.value.id;
  assert.equal(await browser.evaluate(destinationSession,`document.querySelector('#choose-destination').disabled`),true);
  await browser.evaluate(destinationSession,`document.querySelector('#choose-destination').click();document.querySelector('#choose-destination').dispatchEvent(new MouseEvent('click',{bubbles:true}));`);
  await new Promise(r=>setTimeout(r,80));
  assert.equal(await browser.evaluate(destinationSession,`window.pickerCalls`),1);assert.equal((await regressionCommand('destination')).value.id,selectedId);
  assert.equal(await browser.evaluate(destinationSession,`document.querySelector('#choose-destination').getAttribute('aria-pressed')`),'true');
  assert.equal((await browser.send('Target.getTargets')).targetInfos.some(t=>t.url===`chrome-extension://${extensionId}/destination.html`),false);
  await browser.evaluate(destinationSession,`document.querySelector('#browser-destination').click()`);
  for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,50));if((await regressionCommand('destination')).value.mode==='browser')break;}
  assert.equal((await regressionCommand('destination')).value.mode,'browser');
  assert.equal(await browser.evaluate(destinationSession,`document.querySelector('#browser-destination').getAttribute('aria-pressed')`),'true');
  await browser.evaluate(destinationSession,`document.querySelector('#choose-destination').click()`);
  for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,50));if((await regressionCommand('destination')).value.mode==='directory')break;}
  assert.equal((await regressionCommand('destination')).value.mode,'directory');
  report.cases.push({name:'Inline folder picker preserves user activation, handles cancellation, switches to Downloads and persists the chosen directory',folder:chosen.value.name,mode:chosen.value.mode});
  const savedJobs=[];
  for(const media of whole){const started=await regressionCommand('start',{id:media.id,selection:0,filename:'chosen-video'});assert.equal(started.ok,true);savedJobs.push(started.value.id);}
  let directoryJobs;
  for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,200));directoryJobs=(await regressionCommand('list')).value.jobs.filter(j=>savedJobs.includes(j.id));if(directoryJobs.every(j=>['complete','failed'].includes(j.status)))break;}
  console.log('Chosen directory jobs',directoryJobs);assert.equal(directoryJobs.length,2);assert.ok(directoryJobs.every(j=>j.status==='complete'&&!j.browserId),JSON.stringify(directoryJobs));
  assert.deepEqual(directoryJobs.map(j=>j.savedFilename).sort(),['chosen-video (1).mp4','chosen-video.mp4']);
  const completeFiles=await browser.evaluate(destinationSession,`(async()=>{const root=await navigator.storage.getDirectory(),directory=await root.getDirectoryHandle('chosen-test-folder'),files=[];for await(const [name,handle]of directory){const file=await handle.getFile();files.push({name,bytes:Array.from(new Uint8Array(await file.arrayBuffer()))});}return files;})()`);
  assert.equal(completeFiles.length,2);for(const file of completeFiles)assert.deepEqual(Buffer.from(file.bytes),fixtures.get('source.mp4').data);
  report.cases.push({name:'All videos use the chosen global directory and duplicate names are preserved',files:completeFiles.map(f=>({name:f.name,bytes:f.bytes.length}))});
  await browser.send('Target.activateTarget',{targetId:popup.targetId});await browser.send('Page.reload',{},popup.sessionId);await new Promise(r=>setTimeout(r,600));
  assert.equal(await browser.evaluate(popup.sessionId,`document.getElementById('destination-name').textContent`),'chosen-test-folder');
  report.cases.push({name:'Chosen folder survives closing its window and reopening the popup',folder:'chosen-test-folder'});
  // A chosen-folder commit must finish before the job reaches 100%.
  const folderMpd='<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT'+longMedia.duration+'S"><Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="video" width="160" height="90" bandwidth="100000"><BaseURL>'+base+'/long-video.mp4</BaseURL><SegmentBase/></Representation></AdaptationSet><AdaptationSet contentType="audio" mimeType="audio/mp4"><Representation id="audio" bandwidth="96000"><BaseURL>'+base+'/long-audio.mp4</BaseURL><SegmentBase/></Representation></AdaptationSet></Period></MPD>';
  const folderCandidate={...instagramCandidate,groupId:'instagram:folder-long',url:base+'/folder-long.mpd',manifestText:folderMpd,duration:longMedia.duration,entries:[{kind:'dash',url:base+'/folder-long.mpd',manifestText:folderMpd,label:'Все качества'}]};
  await browser.evaluate(instagramPage.sessionId,`window.postMessage({channel:'dan-video-candidates',media:[${JSON.stringify(folderCandidate)}]},location.origin)`);await new Promise(r=>setTimeout(r,250));
  const folderMedia=(await instagramCommand('list')).value.media.find(m=>m.groupId==='instagram:folder-long');assert.ok(folderMedia);
  await browser.evaluate(offscreenSession,`(()=>{globalThis.originalWritable=FileSystemFileHandle.prototype.createWritable;FileSystemFileHandle.prototype.createWritable=async function(...args){const stream=await originalWritable.apply(this,args);if(!this.name.startsWith('instagram-selected-folder'))return stream;return {write:stream.write.bind(stream),abort:stream.abort.bind(stream),close:async()=>{globalThis.folderClosePending=true;await new Promise(resolve=>globalThis.confirmFolderClose=resolve);return stream.close();}};};})()`);
  const folderStarted=await instagramCommand('start',{id:folderMedia.id,selection:0,filename:'instagram-selected-folder'});assert.equal(folderStarted.ok,true,folderStarted.error);
  let savingJob,pendingClose;
  for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,100));savingJob=(await instagramCommand('list')).value.jobs.find(j=>j.id===folderStarted.value.id);pendingClose=await browser.evaluate(offscreenSession,`globalThis.folderClosePending===true`);if(pendingClose||savingJob.status==='failed')break;}
  assert.equal(pendingClose,true,JSON.stringify(savingJob));assert.equal(savingJob.status,'saving');assert.notEqual(savingJob.percent,100);assert.notEqual(savingJob.status,'complete');
  const pendingPercent=savingJob.percent;await browser.evaluate(offscreenSession,`confirmFolderClose();FileSystemFileHandle.prototype.createWritable=originalWritable;`);
  let folderCompleted;
  for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,100));folderCompleted=(await instagramCommand('list')).value.jobs.find(j=>j.id===folderStarted.value.id);if(['complete','failed'].includes(folderCompleted.status))break;}
  assert.equal(folderCompleted.status,'complete',JSON.stringify(folderCompleted));assert.equal(folderCompleted.percent,100);assert.ok(!folderCompleted.browserId);assert.ok(folderCompleted.outputBytes>2000000);
  const folderFile=await browser.evaluate(offscreenSession,`(async()=>{const root=await navigator.storage.getDirectory(),directory=await root.getDirectoryHandle('chosen-test-folder'),file=await(await directory.getFileHandle('instagram-selected-folder.mp4')).getFile();return file.size;})()`);
  assert.equal(folderFile,folderCompleted.outputBytes);
  report.cases.push({name:'Instagram static DASH saves a long video into the chosen directory and reaches 100% only after close commits the real file',bytes:folderFile,pendingPercent});
  await new Promise(r=>setTimeout(r,1200));
  const layout=await browser.send('Page.getLayoutMetrics',{},popup.sessionId);
  const screenshot=await browser.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:440,height:Math.min(1400,layout.cssContentSize.height),scale:1}},popup.sessionId);await fs.writeFile(path.join(root,'test-output/popup.png'),Buffer.from(screenshot.data,'base64'));
  for(const [name,f] of fixtures){const target=path.resolve(root,'test-output/fixtures',name);if(!target.startsWith(path.join(root,'test-output/fixtures')+path.sep))throw new Error('Unexpected fixture path');await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,f.data);}
}catch(error){report.error=error.stack;process.exitCode=1;console.error(error);}
finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));await fs.mkdir(path.join(root,'test-output'),{recursive:true});await fs.writeFile(path.join(root,'test-output/browser-report.json'),JSON.stringify(report,null,2));}
