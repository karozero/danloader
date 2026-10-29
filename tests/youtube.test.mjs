import test from 'node:test';
import assert from 'node:assert/strict';
import {youtubeEntries,resolveYouTube,probeYouTubeEntry} from '../dist/services/youtube/resolver.js';
const url=itag=>`https://r.googlevideo.com/videoplayback?id=video&itag=${itag}&sig=keep%2Bexact`;
const audio=(itag,mime,bitrate,extra={})=>({itag,url:url(itag),mimeType:mime,bitrate,...extra});
const video=(itag,height,mime,extra={})=>({itag,url:url(itag),height,fps:30,mimeType:mime,...extra});

test('YouTube qualities are grouped, sorted and paired with matching original audio',()=>{
  const entries=youtubeEntries({streamingData:{adaptiveFormats:[
    audio(140,'audio/mp4; codecs="mp4a.40.2"',128000,{audioTrack:{audioIsDefault:true}}),audio(141,'audio/mp4',256000,{audioTrack:{audioIsDefault:false}}),audio(251,'audio/webm',160000),
    video(137,1080,'video/mp4; codecs="avc1.640028"'),video(248,1080,'video/webm; codecs="vp9"'),video(136,720,'video/mp4; codecs="avc1.640028"')
  ]}});
  assert.deepEqual(entries.map(e=>e.label),['1080p · H.264','720p · H.264']);
  assert.ok(entries.every(e=>e.kind==='pair'&&e.audioUrl===url(140)));
  assert.equal(entries[0].url,url(137));
});
test('Do not present cipher/n/SABR-only formats or mismatched audio as valid downloads',()=>{
  assert.deepEqual(youtubeEntries({streamingData:{serverAbrStreamingUrl:'https://example.test/sabr',adaptiveFormats:[{itag:137,mimeType:'video/mp4',height:1080}]}}),[]);
  assert.deepEqual(youtubeEntries({streamingData:{adaptiveFormats:[audio(251,'audio/webm',160000),video(137,1080,'video/mp4')]}}),[]);
  assert.deepEqual(youtubeEntries({streamingData:{adaptiveFormats:[audio(140,'audio/mp4',128000),video(137,1080,'video/mp4',{url:url(137)+'&n=unresolved'}),video(136,720,'video/mp4',{signatureCipher:'s=encrypted'})]}}),[]);
});
test('Native player resolver uses page metadata and propagates access errors',async()=>{
 const data={playabilityStatus:{status:'OK'},videoDetails:{title:'Test',lengthSeconds:'42'},streamingData:{adaptiveFormats:[audio(140,'audio/mp4',128000),video(137,1080,'video/mp4')]}};
 const result=await resolveYouTube('JPHT9AvoPSA',{readPlayer:async()=>data});
 assert.equal(result.entries.length,1);assert.equal(result.duration,42);
 await assert.rejects(resolveYouTube('JPHT9AvoPSA',{readPlayer:async()=>({playabilityStatus:{status:'LOGIN_REQUIRED',reason:'Sign in required'}})}),/Sign in required/);
 const sabr=await resolveYouTube('JPHT9AvoPSA',{readPlayer:async()=>({...data,streamingData:{serverAbrStreamingUrl:'https://example.test/sabr',adaptiveFormats:[{height:1080,mimeType:'video/mp4'}]}})});
 assert.equal(sabr.entries.length,0);assert.equal(sabr.qualities[0].label,'1080p');assert.match(sabr.unavailableReason,/SABR/);
});
test('Preflight probes both exact signed URLs with small ranges and reports 403',async()=>{
  const calls=[];let cancelled=0;
  await probeYouTubeEntry({url:url(137),audioUrl:url(140)},{fetcher:async(url,options)=>{calls.push({url,options});return new Response(new ReadableStream({cancel(){cancelled++;}}),{status:206});}});
  assert.equal(cancelled,2);assert.deepEqual(calls.map(c=>c.url),[url(137),url(140)]);assert.ok(calls.every(c=>c.options.headers.Range==='bytes=0-1023'&&c.options.credentials==='include'));
  await assert.rejects(probeYouTubeEntry({url:url(137)},{fetcher:async()=>new Response('Forbidden',{status:403})}),error=>error.status===403);
});
