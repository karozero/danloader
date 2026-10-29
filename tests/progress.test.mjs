import test from 'node:test';
import assert from 'node:assert/strict';
import {applyProgress} from '../dist/application/job-progress.js';

test('Downloaded bytes do not reset when mux output and destination copying start at zero',()=>{
 const job={id:'job',status:'downloading',bytes:1000000};
 applyProgress(job,{status:'finalizing',bytes:0,outputBytes:10});
 assert.equal(job.bytes,1000000);assert.equal(job.status,'finalizing');assert.equal(job.outputBytes,10);
 applyProgress(job,{status:'finalizing',percent:100});assert.equal(job.percent,99);
 applyProgress(job,{status:'downloading',percent:100});assert.equal(job.status,'finalizing');assert.equal(job.percent,99);
 applyProgress(job,{status:'saving',savedBytes:128});assert.equal(job.bytes,1000000);assert.equal(job.savedBytes,128);assert.equal(job.status,'saving');
 applyProgress(job,{status:'downloading',percent:100});assert.equal(job.status,'saving');assert.equal(job.percent,null);
});
