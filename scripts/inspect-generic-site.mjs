import {launch} from './cdp.mjs';
import fs from 'node:fs/promises';import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),browser=await launch(root);
try{
 const {id}=await browser.send('Extensions.loadUnpacked',{path:path.join(root,'dist')});
 const page=await browser.page('about:blank');await browser.send('Network.enable',{},page.sessionId);
 const responses=[];browser.on('Network.responseReceived',(data,session)=>{if(session===page.sessionId&&responses.length<300)responses.push({requestId:data.requestId,url:data.response.url,status:data.response.status,mime:data.response.mimeType,type:data.type});});
 await browser.send('Page.navigate',{url:'https://www.antonov.media/watch?v=f2ab48d7-34ec-4360-a0eb-28b3b0531151'},page.sessionId);
 await new Promise(r=>setTimeout(r,12000));
 const trailer=await browser.evaluate(page.sessionId,`(()=>{const button=[...document.querySelectorAll('button,a')].find(e=>e.textContent.trim()==='Смотреть трейлер');if(button){button.click();return true;}return false;})()`);
 await new Promise(r=>setTimeout(r,6000));
 console.log('Public trailer opened:',trailer);
 const dom=await browser.evaluate(page.sessionId,`(()=>{const videos=[];function walk(root){for(const el of root.querySelectorAll('*')){if(el instanceof HTMLVideoElement)videos.push({html:el.outerHTML.slice(0,2000),src:el.src,currentSrc:el.currentSrc,duration:el.duration,poster:el.poster,ready:el.readyState});if(el.shadowRoot)walk(el.shadowRoot);}}walk(document);return {url:location.href,title:document.title,text:document.body?.innerText.slice(0,1000),videos,iframes:[...document.querySelectorAll('iframe')].map(e=>e.src),scripts:[...document.scripts].map(e=>e.src).filter(Boolean)};})()`);
 const popup=await browser.page('chrome-extension://'+id+'/popup.html');await new Promise(r=>setTimeout(r,600));
 const discovered=await browser.evaluate(popup.sessionId,`(async()=>{const tabs=await chrome.tabs.query({url:'https://www.antonov.media/*'});return chrome.runtime.sendMessage({target:'ui',action:'list',tabId:tabs[0]?.id});})()`);
 let downloaded;
 let networkBenchmark;
 if(process.argv.includes('--download') || process.argv.includes('--benchmark')){
  const master=responses.find(r=>r.status===200 && /mpegurl/i.test(r.mime) && new URL(r.url).pathname.endsWith('/master.m3u8'));
  const media=discovered.value?.media.find(m=>m.url===master?.url);
  if(!media)throw new Error('The public trailer master was not discovered.');
  if(process.argv.includes('--benchmark')){
   await browser.evaluate(page.sessionId,`(()=>{const walk=root=>{for(const e of root.querySelectorAll('*')){if(e instanceof HTMLVideoElement)e.pause();if(e.shadowRoot)walk(e.shadowRoot);}};walk(document);})()`);
   const {parseHls}=await import('../dist/core/hls.js');
   const masterBody=await browser.send('Network.getResponseBody',{requestId:master.requestId},page.sessionId);
   const qualities=parseHls(masterBody.base64Encoded?Buffer.from(masterBody.body,'base64').toString():masterBody.body,master.url);
   const selected=qualities.variants.at(-1);
   const playlist=await browser.evaluate(page.sessionId,`fetch(${JSON.stringify(selected.url)}).then(r=>r.text())`);
   const pieces=parseHls(playlist,selected.url).urls.filter(url=>url!==selected.url).slice(1,5);
   networkBenchmark=await browser.evaluate(page.sessionId,`(async()=>{const started=performance.now(),results=await Promise.all(${JSON.stringify(pieces)}.map(async url=>{const at=performance.now(),response=await fetch(url),body=await response.arrayBuffer();return {status:response.status,bytes:body.byteLength,milliseconds:performance.now()-at};}));return {milliseconds:performance.now()-started,results};})()`);
   console.log('Native network benchmark',JSON.stringify(networkBenchmark));
  }
  if(process.argv.includes('--download')){
  const tabId=media.tabId;
  const call=(action,data={})=>browser.evaluate(popup.sessionId,`chrome.runtime.sendMessage(${JSON.stringify({target:'ui',action,tabId,...data})})`);
  const inspected=await call('inspect',{id:media.id});if(!inspected.ok)throw new Error(inspected.error);
  const selection=inspected.value.variants.length-1;
  const downloadStartedAt=Date.now();
  const started=await call('start',{id:media.id,selection,filename:'antonov-public-trailer',container:'mp4'});if(!started.ok)throw new Error(started.error);
  let job;
  for(let i=0;i<240;i++){await new Promise(r=>setTimeout(r,1000));const state=await call('list');job=state.value.jobs.find(j=>j.id===started.value.id);if(i%20===0)console.log('Trailer progress',JSON.stringify({status:job?.status,percent:job?.percent,bytes:job?.bytes}));if(['complete','failed','cancelled'].includes(job?.status))break;}
  if(job?.status!=='complete')throw new Error('Trailer download failed: '+JSON.stringify(job));
  const filename=await browser.evaluate(popup.sessionId,`chrome.downloads.search({id:${job.browserId}}).then(items=>items[0].filename)`);
  const file=await fs.readFile(filename);const {mp4Tracks}=await import('../dist/core/mp4.js');const tracks=await mp4Tracks(new Blob([file]));
  if(!tracks.video || !tracks.audio || !tracks.payload || !tracks.moov)throw new Error('Trailer is missing complete video/audio tracks.');
  downloaded={milliseconds:Date.now()-downloadStartedAt,bytes:file.length,tracks,quality:inspected.value.variants[selection].label,availableQualities:inspected.value.variants.map(v=>v.label),filename};
 }
 }
 await fs.writeFile(path.join(root,'test-output/antonov-inspection.json'),JSON.stringify({dom,responses,discovered,downloaded,networkBenchmark},null,2));
 console.log(JSON.stringify({title:dom.title,videoDuration:dom.videos[0]?.duration,cards:discovered.value?.media.length,media:responses.filter(e=>/mpegurl|dash/i.test(e.mime)).map(e=>({url:new URL(e.url).origin+new URL(e.url).pathname,status:e.status,mime:e.mime})),downloaded},null,2));

}finally{await browser.close();}
