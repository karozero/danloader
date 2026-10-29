import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {canonicalMediaUrl,hasMetaByteRange} from '../dist/core/media.js';
import {visibleMedia} from '../dist/core/discovery.js';
const pageCode=fs.readFileSync(new URL('../dist/page.js',import.meta.url),'utf8');
function harness(host,path,scripts=[]){
  const messages=[],listeners=new Map(),responses=new Map(),location={href:`https://${host}${path}`,origin:`https://${host}`,hostname:host};
  const document={title:'Social video',querySelectorAll:selector=>selector==='script[type="application/json"]'?scripts:[],scripts:[]};
  const window={postMessage:m=>messages.push(m),addEventListener:(name,handler)=>listeners.set(name,handler),fetch:async url=>{const r=new Response(responses.get(String(url))||'<html/>',{headers:{'Content-Type':responses.has(String(url))?'application/json':'text/html'}});Object.defineProperty(r,'url',{value:String(url)});return r;}};
  class XHR{open(){}addEventListener(){}}
  const customElements={get:()=>null,whenDefined:()=>new Promise(()=>{}),define:()=>{}};
  vm.runInNewContext(pageCode,{window,document,location,XMLHttpRequest:XHR,customElements,URL,Response,TextDecoder,console,Map,JSON,Reflect});
  const scan=(force=false)=>listeners.get('message')({source:window,origin:location.origin,data:{channel:'dan-video-scan',force}});
  return {messages,window,location,document,scan,responses};
}
test('Instagram structured metadata becomes one AV-capable group, not one candidate per chunk',()=>{
  const xml='<MPD><Period><AdaptationSet mimeType="video/mp4"/><AdaptationSet mimeType="audio/mp4"/></Period></MPD>';
  const h=harness('www.instagram.com','/reel/DS7qGjcjoRC/',[{textContent:JSON.stringify({items:[{id:'media-one',code:'DS7qGjcjoRC',video_duration:10,has_audio:true,image_versions2:{candidates:[{url:'https://img.test/poster.jpg'}]},video_versions:[{url:'https://scontent.cdninstagram.com/full.mp4?sig=keep',height:720}],video_dash_manifest:xml},{id:'neighbor',code:'OTHER',video_url:'https://cdn.test/other.mp4'}]})}]);
  h.scan();const candidates=h.messages.flatMap(m=>m.media||[]).filter(m=>m.provider==='instagram');
  assert.ok(candidates.length);const reel=candidates[0];assert.equal(reel.groupId,'instagram:DS7qGjcjoRC');assert.equal(reel.entries[0].kind,'dash');assert.equal(reel.entries[0].manifestText,xml);assert.equal(reel.thumbnail,'https://img.test/poster.jpg');assert.equal(reel.hasAudio,true);const next=candidates.find(m=>m.groupId==='instagram:OTHER');assert.ok(next);assert.equal(next.isCurrent,false);assert.equal(reel.isCurrent,true);assert.equal(next.url,'https://cdn.test/other.mp4');
});
test('Instagram byte-range identity preserves signed authorization and never exposes raw pieces',()=>{
  const raw='https://scontent.cdninstagram.com/a.mp4?bytestart=0&byteend=1023&sig=keep%2Bexact&oh=keep';
  assert.equal(hasMetaByteRange(raw),true);assert.equal(canonicalMediaUrl(raw),'https://scontent.cdninstagram.com/a.mp4?sig=keep%2Bexact&oh=keep');
  assert.deepEqual(visibleMedia([{url:raw,kind:'file',source:'network',size:1000000}]),[]);
});
test('YouTube emits a resolver-backed logical video even when initial player data is SABR-only',()=>{
  const h=harness('www.youtube.com','/watch?v=JPHT9AvoPSA');
  h.window.ytInitialPlayerResponse={videoDetails:{videoId:'JPHT9AvoPSA',title:'YouTube',lengthSeconds:'1644'},playabilityStatus:{status:'OK'},streamingData:{serverAbrStreamingUrl:'https://example.test/sabr',adaptiveFormats:[{itag:137,height:1080}]}};
  h.scan();const candidate=h.messages.flatMap(m=>m.media||[]).find(m=>m.kind==='youtube');
  assert.equal(candidate.videoId,'JPHT9AvoPSA');assert.equal(candidate.groupId,'youtube:JPHT9AvoPSA');assert.equal(candidate.entries,undefined);
});
test('Instagram fetch observer preserves the response and recovers async paired metadata',async()=>{
  const h=harness('www.instagram.com','/reel/DS7qGjcjoRC/'),url='https://www.instagram.com/graphql/query';
  const body='for (;;);'+JSON.stringify({data:{media:{id:'async',code:'DS7qGjcjoRC',has_audio:false,video_versions:[{url:'https://cdn.test/video.mp4',height:720}],audio_url:'https://cdn.test/audio.mp4'}}});
  h.responses.set(url,body);assert.equal(await(await h.window.fetch(url)).text(),body);
  await new Promise(r=>setTimeout(r,20));
  const candidate=h.messages.flatMap(m=>m.media||[]).find(m=>m.groupId==='instagram:DS7qGjcjoRC');assert.ok(candidate);assert.equal(candidate.entries[0].kind,'pair');assert.equal(candidate.entries[0].audioUrl,'https://cdn.test/audio.mp4');
});
test('SPA scrolling retains discovered reels but marks only the newly opened reel current',async()=>{
  const scripts=[{textContent:JSON.stringify({id:'old',code:'DS7qGjcjoRC',video_url:'https://cdn.test/old.mp4'})}];
  const h=harness('www.instagram.com','/reel/DS7qGjcjoRC/',scripts);h.scan();
  h.messages.length=0;h.location.href='https://www.instagram.com/reel/NEXT/';scripts.push({textContent:JSON.stringify({id:'next',code:'NEXT',video_url:'https://cdn.test/next.mp4'})});await new Promise(r=>setTimeout(r,510));h.scan();
  const latest=new Map(h.messages.flatMap(m=>m.media||[]).map(m=>[m.groupId,m]));
  assert.equal(latest.get('instagram:DS7qGjcjoRC').isCurrent,false);assert.equal(latest.get('instagram:NEXT').isCurrent,true);assert.equal(latest.size,2);
});

 test('Reel HTML fallback and different API media IDs merge under the current shortcode',async()=>{
  const h=harness('www.instagram.com','/reel/DS7qGjcjoRC/',[{textContent:JSON.stringify({id:'html-id',code:'DS7qGjcjoRC',video_url:'https://cdn.test/full.mp4'})}]);h.scan();
  h.responses.set('https://www.instagram.com/graphql/query',JSON.stringify({id:'api-id',code:'DS7qGjcjoRC',video_versions:[{url:'https://cdn.test/hd.mp4',height:1080}]}));
  await h.window.fetch('https://www.instagram.com/graphql/query');await new Promise(r=>setTimeout(r,20));
  const groups=h.messages.flatMap(m=>m.media||[]).filter(m=>m.provider==='instagram');
  assert.equal(new Set(groups.map(m=>m.groupId)).size,1);assert.equal(groups.at(-1).entries.length,2);
 });

test('JSON containing an inline MPD is parsed as reel metadata, never as a standalone JSON manifest',async()=>{
 const h=harness('www.instagram.com','/reel/DS7qGjcjoRC/');
 const xml='<MPD><Period><AdaptationSet mimeType="video/mp4"/></Period></MPD>';
 h.responses.set('https://www.instagram.com/graphql/query',JSON.stringify({id:'api',code:'DS7qGjcjoRC',video_dash_manifest:xml}));
 await h.window.fetch('https://www.instagram.com/graphql/query');await new Promise(r=>setTimeout(r,20));
 const candidates=h.messages.flatMap(m=>m.media||[]);assert.ok(candidates.some(m=>m.groupId==='instagram:DS7qGjcjoRC'));
 assert.ok(candidates.every(m=>m.provider==='instagram'));assert.ok(candidates.every(m=>m.manifestText===xml));
});

test('Many encodings of one Instagram quality cannot crowd lower resolutions out of the candidate limit',()=>{
 const versions=Array.from({length:45},(_,i)=>({url:'https://cdn.test/720-'+i+'.mp4',width:720,height:1280,bitrate:100+i}));versions.push({url:'https://cdn.test/360.mp4',width:360,height:640});
 const h=harness('www.instagram.com','/reel/DS7qGjcjoRC/',[{textContent:JSON.stringify({id:'video',code:'DS7qGjcjoRC',video_versions:versions})}]);h.scan();
 const item=h.messages.flatMap(m=>m.media||[]).filter(m=>m.provider==='instagram').at(-1);assert.equal(item.entries.length,2);assert.ok(item.entries.some(e=>e.height===640));assert.ok(item.entries.some(e=>e.bitrate===144));
});

test('A late prefetched reel without shortcode cannot overwrite the currently playing reel',async()=>{
 const xml=url=>'<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation><BaseURL>'+url+'</BaseURL></Representation></AdaptationSet></Period></MPD>';
 const scripts=[{textContent:JSON.stringify({items:[{id:'111',code:'CURRENT',caption:{text:'Current video'},video_url:'https://cdn.test/current.mp4',video_dash_manifest:xml('https://cdn.test/current.mp4')},{id:'222',code:'NEXT',caption:{text:'Next video'},video_url:'https://cdn.test/next.mp4'}]})}];
 const h=harness('www.instagram.com','/reel/CURRENT/',scripts);h.scan();
 h.responses.set('https://www.instagram.com/graphql/query',JSON.stringify({id:'222',video_dash_manifest:xml('https://cdn.test/next.mp4')}));await h.window.fetch('https://www.instagram.com/graphql/query');await new Promise(r=>setTimeout(r,20));
 const latest=new Map(h.messages.flatMap(m=>m.media||[]).filter(m=>m.provider==='instagram').map(m=>[m.groupId,m]));
 assert.equal(latest.size,2);assert.equal(latest.get('instagram:CURRENT').isCurrent,true);assert.ok(latest.get('instagram:CURRENT').entries.every(e=>!e.url.includes('next')&&!e.manifestText?.includes('next.mp4')));
 assert.equal(latest.get('instagram:NEXT').isCurrent,false);assert.equal(latest.get('instagram:NEXT').title,'Next video');
});
test('Unowned embedded DASH strings are never assigned to the URL of the opened reel',()=>{
 const h=harness('www.instagram.com','/reel/CURRENT/',[{textContent:JSON.stringify({id:'1',code:'CURRENT',video_url:'https://cdn.test/current.mp4'})}]);
 h.document.scripts=[{textContent:JSON.stringify({video_dash_manifest:'<MPD><Period><BaseURL>https://cdn.test/next.mp4</BaseURL></Period></MPD>'})}];h.scan();
 const items=h.messages.flatMap(m=>m.media||[]);assert.ok(items.length);assert.ok(items.every(m=>m.url==='https://cdn.test/current.mp4'));
});
test('A numeric ID becomes a shortcode alias only when a record explicitly binds them',async()=>{
 const h=harness('www.instagram.com','/reel/CURRENT/',[{textContent:JSON.stringify({pk:'222_999',video_url:'https://cdn.test/next.mp4'})}]);h.scan();
 const initial=h.messages.flatMap(m=>m.media||[]).find(m=>m.provider==='instagram');assert.equal(initial.groupId,'instagram:id:222');assert.equal(initial.isCurrent,false);
 h.responses.set('https://www.instagram.com/graphql/query',JSON.stringify({pk:'222_999',code:'NEXT',video_url:'https://cdn.test/next.mp4'}));await h.window.fetch('https://www.instagram.com/graphql/query');await new Promise(r=>setTimeout(r,20));
 const updated=h.messages.flatMap(m=>m.media||[]).filter(m=>m.groupId==='instagram:NEXT').at(-1);assert.deepEqual(Array.from(updated.aliasGroupIds),['instagram:id:222']);assert.equal(updated.isCurrent,false);
});

test('The current Reel is recognized from its exact numeric media ID when code is omitted',()=>{
 const code='DS7qGjcjoRC',id=BigInt('0x'+Buffer.from('A'.repeat(12-code.length)+code.replaceAll('-','+').replaceAll('_','/'),'base64').toString('hex')).toString();
 const h=harness('www.instagram.com','/reel/'+code+'/',[{textContent:JSON.stringify({items:[{pk:(BigInt(id)+1n).toString(),video_url:'https://cdn.test/next.mp4'},{pk:id+'_999',video_url:'https://cdn.test/current.mp4'}]})}]);h.scan();
 const items=new Map(h.messages.flatMap(m=>m.media||[]).map(m=>[m.groupId,m]));
 assert.equal(items.get('instagram:'+code).isCurrent,true);assert.equal(items.get('instagram:'+code).url,'https://cdn.test/current.mp4');assert.equal([...items.values()].filter(m=>m.isCurrent).length,1);assert.equal(items.size,2);
});

test('Unsafe numeric PKs cannot merge distinct reels when exact string IDs are available',()=>{
 const h=harness('www.instagram.com','/reel/CURRENT/',[{textContent:JSON.stringify({items:[{pk:9007199254740992,id:'9007199254740993',video_url:'https://cdn.test/one.mp4'},{pk:9007199254740992,id:'9007199254740994',video_url:'https://cdn.test/two.mp4'}]})}]);h.scan();
 const items=new Map(h.messages.flatMap(m=>m.media||[]).map(m=>[m.groupId,m]));assert.equal(items.size,2);assert.ok(items.has('instagram:id:9007199254740993'));assert.ok(items.has('instagram:id:9007199254740994'));
});

test('Partial updates keep the proven numeric ID binding for subsequent ID-only responses',async()=>{
 const h=harness('www.instagram.com','/reel/CURRENT/',[{textContent:JSON.stringify({id:'777',code:'CURRENT',video_url:'https://cdn.test/current.mp4'})}]);h.scan();
 for(const body of [{code:'CURRENT',video_url:'https://cdn.test/new.mp4'},{id:'777',video_url:'https://cdn.test/new.mp4'}]){
  h.responses.set('https://www.instagram.com/graphql/query',JSON.stringify(body));await h.window.fetch('https://www.instagram.com/graphql/query');await new Promise(r=>setTimeout(r,20));
 }
 const last=h.messages.flatMap(m=>m.media||[]).at(-1);assert.equal(last.groupId,'instagram:CURRENT');assert.equal(last.instagramMediaId,'777');assert.equal(last.isCurrent,true);
});

test('Forced scroll scans cannot be dropped by the ordinary snapshot throttle',()=>{
 const scripts=[{textContent:JSON.stringify({id:'1',code:'FIRST',video_url:'https://cdn.test/first.mp4'})}],h=harness('www.instagram.com','/reel/FIRST/',scripts);h.scan();h.messages.length=0;
 h.location.href='https://www.instagram.com/reel/SECOND/';scripts.push({textContent:JSON.stringify({id:'2',code:'SECOND',video_url:'https://cdn.test/second.mp4'})});h.scan(true);
 assert.ok(h.messages.flatMap(m=>m.media||[]).some(m=>m.groupId==='instagram:SECOND'&&m.isCurrent));
});
