import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../dist/youtube-session.js',import.meta.url),'utf8');
function page(){
 const messages=[],calls=[],handlers=[],location={href:'https://www.youtube.com/watch?v=JPHT9AvoPSA',hostname:'www.youtube.com',pathname:'/watch',origin:'https://www.youtube.com'};
 let status=200;
 const window={postMessage:m=>messages.push(m),addEventListener:(event,callback)=>handlers.push(callback),fetch:async(url,options)=>{calls.push({url:String(url),options});if(url instanceof Request)await url.arrayBuffer();return new Response(Uint8Array.of(1,2,3),{status,headers:{'Content-Type':'application/vnd.yt-ump'}});}};
 class XHR{open(){}send(){}setRequestHeader(){}addEventListener(){}}
 vm.runInNewContext(source,{window,location,XMLHttpRequest:XHR,URL,Uint8Array,ArrayBuffer,Blob,Request,Headers,AbortController,AbortSignal,btoa,atob,Date,Map,WeakMap,Reflect,Response});
 return {window,messages,calls,location,setStatus:s=>status=s,request:async input=>{messages.length=0;for(const handler of handlers)await handler({source:window,origin:location.origin,data:{channel:'dan-video-youtube-media-request',uid:'request',videoId:'JPHT9AvoPSA',jobId:'job',...input}});return messages.find(m=>m.channel==='dan-video-youtube-media-result');}};
}
test('A SABR session exists only after a successful normal player media request',async()=>{
 const h=page();assert.equal(h.window.DanVideoSession.ready(),false);
 assert.equal((await h.request({action:'session'})).ok,false);
 await h.window.fetch('https://r.googlevideo.com/videoplayback?id=native',{method:'POST',body:Uint8Array.of(4,5),credentials:'include',headers:{'X-Native-Context':'keep'}});await new Promise(r=>setTimeout(r,0));
 assert.equal(h.window.DanVideoSession.ready(),true);const session=await h.request({action:'session'});assert.equal(session.ok,true);assert.equal(session.value.body,btoa(String.fromCharCode(4,5)));
 const result=await h.request({action:'fetch',url:'https://r.googlevideo.com/videoplayback?id=native&rn=1',body:btoa('request')});
 assert.equal(result.ok,true);assert.equal(h.calls.at(-1).options.credentials,'include');assert.equal(h.calls.at(-1).options.headers.get('X-Native-Context'),'keep');
 assert.equal((await h.request({action:'fetch',url:'https://r.googlevideo.com/videoplayback?id=another-video',body:btoa('x')})).ok,false);
 h.location.href='https://www.youtube.com/watch?v=ANOTHER1234';assert.equal(h.window.DanVideoSession.ready(),false);
});
test('An HTTP 403 does not create a native SABR session',async()=>{
 const h=page();h.setStatus(403);await h.window.fetch('https://r.googlevideo.com/videoplayback?id=native',{method:'POST',body:Uint8Array.of(4)});await new Promise(r=>setTimeout(r,0));
 assert.equal(h.window.DanVideoSession.ready(),false);assert.equal(h.calls.length,1);
});

test('Observing a Request clones its body before the real fetch consumes it',async()=>{
 const h=page(),request=new Request('https://r.googlevideo.com/videoplayback?id=native',{method:'POST',body:Uint8Array.of(4,5)});
 assert.equal((await h.window.fetch(request)).ok,true);await new Promise(r=>setTimeout(r,10));
 assert.equal(h.window.DanVideoSession.ready(),true);assert.equal(request.bodyUsed,true);
});
