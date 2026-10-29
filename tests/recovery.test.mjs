import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {terminal} from '../dist/core/media.js';
const source=fs.readFileSync(new URL('../dist/service.js',import.meta.url),'utf8').replace(/^import[\s\S]*?;\r?$/gm,'');
test('Restart without an offscreen loader fails stale queued and active jobs instead of auto-starting them',async()=>{
 const stored={jobs:[{id:'old-queue',status:'queued',request:{media:{url:'https://example.test/video.mp4'}}},{id:'old-active',status:'preparing',request:{}},{id:'finished',status:'complete'}]},writes=[];
 const event={addListener(){}};let created=0;
 const chrome={storage:{session:{setAccessLevel:async()=>{},get:async()=>stored,set:async value=>writes.push(value)}},declarativeNetRequest:{updateSessionRules:async()=>{},getSessionRules:async()=>[]},runtime:{getContexts:async()=>[],onMessage:event},offscreen:{createDocument:async()=>{created++;}},webRequest:{onSendHeaders:event,onResponseStarted:event},webNavigation:{onCommitted:event,onHistoryStateUpdated:event},tabs:{onRemoved:event},downloads:{onChanged:event}};
 const context={chrome,terminal,queueMicrotask(){},setTimeout,clearTimeout};
 vm.runInNewContext(source+';globalThis.recovered=ready.then(()=>[...jobs.values()]);',context);
 const result=await context.recovered;assert.deepEqual(Array.from(result,j=>j.status),['failed','failed','complete']);
 assert.ok(result.slice(0,2).every(j=>!j.request&&j.error));assert.equal(created,0);assert.ok(writes.some(w=>w.jobs?.every(j=>terminal(j.status))));
});
