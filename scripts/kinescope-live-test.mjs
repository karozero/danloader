import {launch} from './cdp.mjs';import fs from 'node:fs/promises';import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),browser=await launch(root),responses=[],bodies=[],sessions=new Set();
try{
 const {id}=await browser.send('Extensions.loadUnpacked',{path:path.join(root,'dist')});
 browser.on('Target.attachedToTarget',async({sessionId,targetInfo})=>{if(targetInfo.type==='iframe'){sessions.add(sessionId);await browser.send('Runtime.enable',{},sessionId).catch(()=>{});await browser.send('Network.enable',{},sessionId).catch(()=>{});await browser.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},sessionId).catch(()=>{});}});
 const page=await browser.page('about:blank');sessions.add(page.sessionId);await browser.send('Network.enable',{},page.sessionId);await browser.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},page.sessionId);
 browser.on('Network.responseReceived',(event,session)=>{if(sessions.has(session)&&responses.length<500)responses.push({session,requestId:event.requestId,frameId:event.frameId,url:event.response.url,status:event.response.status,mime:event.response.mimeType,type:event.type});});
 await browser.send('Page.navigate',{url:process.argv.includes('--demo')?'https://kinescope.io/embed/203613411':'https://sponsr.ru/greenpig/190230/Klub_Zelenoi_Svini_344_Francuzskii_vypusk/'},page.sessionId);await new Promise(r=>setTimeout(r,12000));
 const frames=[];for(const session of sessions){try{frames.push({session,...await browser.evaluate(session,`({url:location.href,title:document.title,text:document.body?.innerText.slice(0,2000),iframes:[...document.querySelectorAll('iframe')].map(e=>e.src),videos:[...document.querySelectorAll('video')].map(e=>({src:e.src,currentSrc:e.currentSrc,poster:e.poster,duration:e.duration})),scripts:[...document.scripts].map(e=>({src:e.src,type:e.type,head:e.src?'':e.textContent.slice(0,180)}))})`)});}catch{}}
 let verification;
 if(process.argv.includes('--demo')){
  const popup=await browser.page('chrome-extension://'+id+'/popup.html');await new Promise(r=>setTimeout(r,800));
  const tabId=await browser.evaluate(popup.sessionId,`chrome.tabs.query({url:'https://kinescope.io/embed/*'}).then(t=>t[0]?.id)`);
  const call=(action,data={})=>browser.evaluate(popup.sessionId,`chrome.runtime.sendMessage(${JSON.stringify({target:'ui',action,tabId,...data})})`);
  let media;for(let i=0;i<30;i++){const list=await call('list');media=list.value?.media;if(media?.some(m=>m.provider==='kinescope'))break;await new Promise(r=>setTimeout(r,200));}
  console.log('Kinescope cards',JSON.stringify(media?.map(m=>({id:m.id,kind:m.kind,provider:m.provider,groupId:m.groupId,title:m.title,thumbnail:Boolean(m.thumbnail),duration:m.duration}))));
  const item=media?.find(m=>m.provider==='kinescope');if(!item)throw new Error('Kinescope logical video was not discovered');
  const inspected=await call('inspect',{id:item.id});if(!inspected.ok)throw new Error(inspected.error);
  verification={cards:media.length,title:item.title,poster:Boolean(item.thumbnail),qualities:inspected.value.variants.map(v=>v.label)};
  if(process.argv.includes('--download')){
   await browser.evaluate(page.sessionId,`document.querySelector('video')?.pause()`);
   const at=Date.now(),selection=inspected.value.variants.length-1;
   const started=await call('start',{id:item.id,selection,container:'mp4',filename:'kinescope-public-demo'});if(!started.ok)throw new Error(started.error);
   let job;for(let i=0;i<180;i++){await new Promise(r=>setTimeout(r,1000));job=(await call('list')).value.jobs.find(j=>j.id===started.value.id);if(i%10===0)console.log('Kinescope progress',JSON.stringify({status:job?.status,percent:job?.percent,bytes:job?.bytes}));if(['complete','failed'].includes(job?.status))break;}
   if(job?.status!=='complete')throw new Error(JSON.stringify(job));
   const filename=await browser.evaluate(popup.sessionId,`chrome.downloads.search({id:${job.browserId}}).then(items=>items[0].filename)`);
   const file=await fs.readFile(filename),{mp4Tracks}=await import('../dist/core/mp4.js');const tracks=await mp4Tracks(new Blob([file]));if(!tracks.video||!tracks.audio||!tracks.moov||!tracks.payload)throw new Error('Missing complete AV tracks');
   Object.assign(verification,{milliseconds:Date.now()-at,bytes:file.length,tracks,filename});
  }
  console.log('Kinescope verification',JSON.stringify(verification));
 }
 for(const response of responses.filter(r=>r.status===200&&/kinescope/.test(r.url)&&/json|mpegurl|dash|text\/html/i.test(r.mime)).slice(0,30)){try{const value=await browser.send('Network.getResponseBody',{requestId:response.requestId},response.session);const body=value.base64Encoded?Buffer.from(value.body,'base64').toString():value.body;if(body.length<2000000)bodies.push({...response,body});}catch{}}
 await fs.writeFile(path.join(root,process.argv.includes('--demo')?'test-output/kinescope-demo.json':'test-output/kinescope-inspection.json'),JSON.stringify({frames,responses,bodies,verification},null,2));
 console.log(JSON.stringify({frames:frames.map(f=>({url:f.url,title:f.title,iframes:f.iframes,text:f.text?.slice(0,300)})),responses:responses.filter(r=>/kinescope|mpegurl|dash|video|audio/i.test(r.url+' '+r.mime)).map(({url,status,mime,type})=>({url:new URL(url).origin+new URL(url).pathname,status,mime,type})),bodyCount:bodies.length},null,2));
}finally{await browser.close();}
