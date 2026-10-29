import test from 'node:test';
import assert from 'node:assert/strict';
import {shiftPacket} from '../dist/infrastructure/remux.js';
const full=(p,key)=>(p[key]>>>0)+p[key+'hi']*4294967296;
test('Remux timestamp shifts preserve audio/video offsets and B-frame composition offsets',()=>{
 const p={pts:0,ptshi:0,dts:-1024,dtshi:-1,time_base_num:1,time_base_den:48000};
 const shifted=shiftPacket(p,1024/48000);assert.equal(full(shifted,'dts'),0);assert.equal(full(shifted,'pts'),1024);assert.equal(p.dts,-1024);
});
test('Remux timestamps preserve high bits and unknown PTS sentinel',()=>{
 const p={pts:0,ptshi:-2147483648,dts:12,dtshi:2,time_base_num:1,time_base_den:1000};
 const shifted=shiftPacket(p,1);assert.equal(shifted.ptshi,-2147483648);assert.equal(shifted.pts,0);assert.equal(full(shifted,'dts'),2*4294967296+1012);
});
