import test from 'node:test';
import assert from 'node:assert/strict';
import * as stream from 'googlevideo/sabr-stream';
import * as protos from 'googlevideo/protos';
import * as utils from 'googlevideo/utils';
import {downloadNativeSabr,toBase64,fromBase64} from '../dist/services/youtube/native-sabr.js';
import {sabrEntries} from '../dist/services/youtube/resolver.js';
import {videoId,video,audio,nativeBody,mediaResponse,protectedResponse} from './fixtures/sabr.mjs';
const engine={...stream,...protos,...utils};
test('SABR qualities require a native session and retain selected video/audio format IDs',()=>{
 const data={videoDetails:{videoId},streamingData:{serverAbrStreamingUrl:'https://r.googlevideo.com/videoplayback',adaptiveFormats:[video,audio]}};
 assert.equal(sabrEntries(data,videoId).length,0);data.danSabrReady=true;
 const entries=sabrEntries(data,videoId);assert.equal(entries.length,1);assert.equal(entries[0].kind,'sabr');assert.equal(entries[0].sabrVideo.itag,137);assert.equal(entries[0].sabrAudio.itag,140);
});
test('Native SABR engine separates complete UMP video/audio and keeps the native client and issued token',async()=>{
 const received={video:[],audio:[]},videoBytes=Buffer.from('video-payload'),audioBytes=Buffer.from('audio-payload');let count=0;
 await downloadNativeSabr({videoId,video,audio,duration:2.2,videoSink:chunk=>received.video.push(Buffer.from(chunk)),audioSink:chunk=>received.audio.push(Buffer.from(chunk)),requestPage:async(operation,data)=>{
  if(operation==='session')return {url:'https://r.googlevideo.com/videoplayback?id=native',body:toBase64(nativeBody)};
  count++;const req=protos.VideoPlaybackAbrRequest.decode(fromBase64(data.body));assert.equal(req.streamerContext.clientInfo.clientName,1);assert.equal(req.streamerContext.clientInfo.clientVersion,'native-test');assert.deepEqual(req.streamerContext.poToken,Uint8Array.of(9,8,7));assert.equal(req.selectedVideoFormatIds[0].itag,137);assert.equal(req.selectedAudioFormatIds[0].itag,140);
  return {body:toBase64(mediaResponse(videoBytes,audioBytes)),mime:'application/vnd.yt-ump'};
 }},engine);
 assert.equal(count,1);assert.deepEqual(Buffer.concat(received.video),videoBytes);assert.deepEqual(Buffer.concat(received.audio),audioBytes);
});
test('SABR protection rejection stops instead of minting or retrying tokens',async()=>{
 let requests=0;
 await assert.rejects(downloadNativeSabr({videoId,video,audio,videoSink(){},audioSink(){},requestPage:async operation=>operation==='session'?{url:'https://r.googlevideo.com/videoplayback?id=native',body:toBase64(nativeBody)}:(requests++,{body:toBase64(protectedResponse()),mime:'application/vnd.yt-ump'})},engine),/подтверждение/);
 assert.equal(requests,1);
});
