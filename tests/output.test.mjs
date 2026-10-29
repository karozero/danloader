import test from 'node:test';import assert from 'node:assert/strict';
import {videoOutput,resolveOutput,outputPolicy} from '../dist/domain/media-output.js';
import {createDownloadEngine} from '../dist/application/download-engine.js';

test('Legacy video requests retain their container while explicit output intents stay distinct',()=>{
 assert.deepEqual(resolveOutput(undefined,'mkv'),{kind:'video',container:'mkv'});
 assert.deepEqual(videoOutput(),{kind:'video',container:'mp4'});
 assert.deepEqual(resolveOutput({kind:'audio',container:'m4a'}),{kind:'audio',container:'m4a'});
 assert.throws(()=>resolveOutput({kind:'unknown',container:'mp4'}),/тип результата/);
 assert.throws(()=>resolveOutput({kind:'audio',container:'mp4'}),/тип результата/);
});

test('Audio output requires an audio track and excludes video independently of HTTP/HLS/DASH transport',()=>{
 assert.deepEqual(outputPolicy({kind:'audio',container:'m4a'}),{extension:'m4a',video:'excluded',audio:'required'});
 assert.deepEqual(outputPolicy({kind:'video',container:'mkv'}),{extension:'mkv',video:'required',audio:'optional'});
});

test('Future audio intents fail explicitly before any network or header mutation until execution is enabled',async()=>{
 let touched=false;const engine=createDownloadEngine({loadManifest:async()=>{touched=true;return '';},prepareUrls:async()=>{touched=true;}});
 await assert.rejects(()=>engine.download({id:'a',url:'https://example.test/a.m3u8',kind:'hls'},0,undefined,{kind:'audio',container:'m4a'}),{code:'OUTPUT_NOT_ENABLED'});
 assert.equal(touched,false);
 const plan=await engine.download({id:'v',url:'https://example.test/v.mp4',kind:'file'},0,undefined,{kind:'video',container:'mkv'});
 assert.deepEqual(plan.output,{kind:'video',container:'mkv'});assert.equal(plan.variant.url,'https://example.test/v.mp4');
});
