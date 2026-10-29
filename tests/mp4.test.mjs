import test from 'node:test';
import assert from 'node:assert/strict';
import {mp4Tracks,requireVideoMp4} from '../dist/core/mp4.js';
const box=(type,...data)=>{const payload=Buffer.concat(data),header=Buffer.alloc(8);header.writeUInt32BE(payload.length+8);header.write(type,4,'ascii');return Buffer.concat([header,payload]);};
const track=handler=>box('trak',box('mdia',box('hdlr',Buffer.alloc(8),Buffer.from(handler),Buffer.alloc(4))));
const mp4=(tracks,media=true)=>new Blob([box('ftyp',Buffer.from('isom0000')),box('moov',...tracks.map(track)),...(media?[box('mdat',Buffer.from([1,2,3,4]))]:[])]);
test('MP4 validation requires a video track and actual media payload',async()=>{
  assert.deepEqual(await mp4Tracks(mp4(['vide','soun'])),{video:true,audio:true,payload:true,moov:true});
  await requireVideoMp4(mp4(['vide','soun']),{requireAudio:true});
  await assert.rejects(requireVideoMp4(mp4(['soun'])),/аудиодорожку/);
  await assert.rejects(requireVideoMp4(mp4(['vide'],false)),/фрагмент/);
  await assert.rejects(requireVideoMp4(new Blob([box('moof'),box('mdat',Buffer.from('fragment'))])),/фрагмент/);
});
test('Adaptive results cannot silently lose required audio',async()=>{
  await requireVideoMp4(mp4(['vide']));
  await assert.rejects(requireVideoMp4(mp4(['vide']),{requireAudio:true}),/отсутствует аудиодорожка/);
});
