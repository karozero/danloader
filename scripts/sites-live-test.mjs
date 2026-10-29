import {launch} from './cdp.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),videoId=process.env.YOUTUBE_TEST_ID||'JPHT9AvoPSA';
if(!/^[\w-]{11}$/.test(videoId))throw new Error('Invalid test video ID');
const report={cases:[],instagram:{url:'https://www.instagram.com/reel/DS7qGjcjoRC/'}},directory=path.join(root,'test-output/sites');
await fs.mkdir(directory,{recursive:true});let browser;
try{
  browser=await launch(root);report.browser=browser.version.Browser;
  const {id}=await browser.send('Extensions.loadUnpacked',{path:path.join(root,'dist')});
  const youtube=await browser.page('https://www.youtube.com/watch?v='+videoId);
  await new Promise(r=>setTimeout(r,5000));
  const popup=await browser.page(`chrome-extension://${id}/popup.html`);await new Promise(r=>setTimeout(r,400));
  const tabId=await browser.evaluate(popup.sessionId,`chrome.tabs.query({url:'https://www.youtube.com/*'}).then(t=>t[0]?.id)`);
  if(tabId){
    const list=await browser.evaluate(popup.sessionId,`chrome.runtime.sendMessage({target:'ui',action:'list',tabId:${tabId}})`);
    const item=list?.value?.media.find(m=>m.provider==='youtube');
    if(item){
      const qualities=await browser.evaluate(popup.sessionId,`chrome.runtime.sendMessage({target:'ui',action:'inspect',tabId:${tabId},id:${JSON.stringify(item.id)}})`);
      report.youtubeUi={ok:qualities?.ok,error:qualities?.error,qualities:qualities?.value?.variants?.map(v=>v.label)};
      report.youtubeUi.status=qualities?.ok?'metadata-verified':'access-or-protocol-unavailable';
    }else report.youtubeUi={ok:false,reason:'The test browser did not expose player metadata.'};
  }
  const instagram=await browser.page(report.instagram.url);await new Promise(r=>setTimeout(r,7000));
  const state=await browser.evaluate(instagram.sessionId,`({url:location.href,title:document.title,ready:document.readyState,loginRequired:/log in|sign up|войти|зарегистрируйтесь/i.test(document.body?.innerText||'')})`).catch(error=>({error:error.message}));
  const igTab=await browser.evaluate(popup.sessionId,`chrome.tabs.query({url:'https://www.instagram.com/*'}).then(t=>t[0]?.id)`);
  const igList=igTab?await browser.evaluate(popup.sessionId,`chrome.runtime.sendMessage({target:'ui',action:'list',tabId:${igTab}})`):null;
  const reel=igList?.value?.media.find(m=>m.provider==='instagram');
  if(reel){const result=await browser.evaluate(popup.sessionId,`chrome.runtime.sendMessage({target:'ui',action:'inspect',tabId:${igTab},id:${JSON.stringify(reel.id)}})`);report.instagram={...report.instagram,state,status:result?.ok?'metadata-verified':'unverified',qualities:result?.value?.variants?.map(v=>v.label),error:result?.error};}
  else report.instagram={...report.instagram,state,status:'unverified',reason:'Public test browser could not obtain authorized reel metadata. No login or access challenge was bypassed.'};
  console.log('Instagram live boundary',report.instagram);
}catch(error){report.error=error.message;process.exitCode=1;console.error(error);}
finally{if(browser)await browser.close();await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));}
