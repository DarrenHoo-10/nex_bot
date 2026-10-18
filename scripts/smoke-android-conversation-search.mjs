// Run against the owned Android workspace fixture and its explicitly forwarded WebView.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { connectAndroidWorkspace } from './testing/android-workspace-cdp.mjs';
const fixtureFile=process.argv[2];
if(!fixtureFile)throw Error('Provide the owned fixture.json path');
const fixture=JSON.parse(readFileSync(fixtureFile,'utf8'));
const c=await connectAndroidWorkspace(Number(process.argv[3]||9227)),cases=[];
const wait=async expression=>{const end=Date.now()+30000;while(!await c.evaluate(expression)){if(Date.now()>end)throw Error('Timed out: '+expression);await new Promise(resolve=>setTimeout(resolve,100));}};
const input=(selector,value)=>c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
try {
 const status=await fetch(fixture.origin+'/api/auth/status',{headers:{Authorization:'Bearer '+fixture.token}}).then(r=>r.json());
 assert.equal(status.account.displayName,'演示账号');
 assert.equal(await c.evaluate("fetch('/api/auth/status').then(r=>r.json()).then(s=>s.account.displayName)"),'演示账号');
 const query='搜索验证 '+Date.now();
 await wait("!!document.querySelector('.composer textarea')");
 await input('.composer textarea',query);
 await wait("!document.querySelector('.composer .send').disabled");
 await c.evaluate("document.querySelector('.composer .send').click()");
 await wait(`document.querySelector('.transcript')?.textContent.includes(${JSON.stringify(query)})`);
 await c.evaluate("document.querySelector('.mobile-menu').click()");
 await input('[aria-label=搜索会话记录]',query);
 await wait("document.querySelectorAll('.conversation-search-result').length===1");
 cases.push('native-transport-conversation-search');
 await c.evaluate("document.querySelector('.conversation-search-result').click()");
 await wait(`document.querySelector('[data-search-match=true]')?.textContent.includes(${JSON.stringify(query)})&&!document.querySelector('.contact-sidebar.is-open')`);
 cases.push('search-result-opens-and-highlights-message');
 await c.evaluate("[...document.querySelectorAll('.transcript button')].find(e=>e.textContent==='返回最新消息').click()");
 await wait("!document.querySelector('[data-search-match=true]')");
 cases.push('return-to-latest');
 const result={passed:true,cases};
 writeFileSync(path.join(path.dirname(fixtureFile),'search-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {c.close();}
