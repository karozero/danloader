import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
export async function launch(root) {
  const executable=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const profile=path.join(root,'.browser-profile-'+Date.now());
  await fs.mkdir(profile,{recursive:true});
  await fs.mkdir(path.join(profile,'Default'),{recursive:true});
  await fs.writeFile(path.join(profile,'Default/Preferences'),JSON.stringify({download:{default_directory:path.join(root,'test-output/downloads'),prompt_for_download:false,directory_upgrade:true}}));
  const child=spawn(executable,['--headless=new','--no-first-run','--no-default-browser-check','--disable-sync','--disable-background-networking','--disable-component-update','--enable-unsafe-extension-debugging','--disable-features=DisableLoadExtensionCommandLineSwitch','--autoplay-policy=no-user-gesture-required','--remote-debugging-port=0',`--user-data-dir=${profile}`,`--load-extension=${path.join(root,'dist')}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
  let port;
  for(let i=0;i<100;i++){try{port=Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await new Promise(r=>setTimeout(r,100));}}
  if(!port){child.kill();throw new Error('Chrome did not expose a test debugging endpoint.');}
  const version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket=new WebSocket(version.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let next=1;const pending=new Map(),listeners=new Map();
  socket.onmessage=({data})=>{const m=JSON.parse(data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(p){clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}else for(const callback of listeners.get(m.method)||[])callback(m.params,m.sessionId);};
  function send(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=next++,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},60000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...sessionId?{sessionId}:{}}));});}
  function on(method,callback){if(!listeners.has(method))listeners.set(method,[]);listeners.get(method).push(callback);}
  async function page(url){const {targetId}=await send('Target.createTarget',{url});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});await send('Runtime.enable',{},sessionId);return {targetId,sessionId};}
  async function evaluate(sessionId,expression){const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},sessionId);if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
  async function close(){
    try{await send('Browser.close');}catch{}socket.close();child.kill();
    await new Promise(r=>setTimeout(r,500));
    const resolved=path.resolve(profile);
    if(path.dirname(resolved)!==root || !path.basename(resolved).startsWith('.browser-profile-'))throw new Error('Unexpected test profile path');
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:300}).catch(()=>{});
  }
  return {send,on,page,evaluate,close,version,profile};
}
