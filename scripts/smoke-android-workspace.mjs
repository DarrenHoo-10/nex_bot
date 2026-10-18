// Run only against fixture-android-workspace.mjs and its explicitly forwarded emulator.
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { connectAndroidWorkspace } from "./testing/android-workspace-cdp.mjs";
const fixtureFile = process.argv[2] || "release/android-workspace/fixture.json";
const fixture = JSON.parse(readFileSync(fixtureFile, "utf8"));
const c = await connectAndroidWorkspace(Number(process.argv[3] || 9227));
const cases = [];
const q = JSON.stringify;
const wait = async (expression, label = expression) => {
  const end = Date.now() + 20000;
  while (!await c.evaluate(expression)) {
    if (Date.now() > end) throw new Error("Timeout: " + label);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
};
const click = async selector => { await wait(`!!document.querySelector(${q(selector)}) && !document.querySelector(${q(selector)}).disabled`); await c.evaluate(`document.querySelector(${q(selector)}).click()`); };
const button = async (text, scope = "document") => {
  const expression = `[...${scope}.querySelectorAll('button')].find(e=>e.getClientRects().length&&(e.textContent.trim()===${q(text)}||e.querySelector(':scope > span')?.textContent.trim()===${q(text)}))`;
  await wait(`!!(${expression}) && !(${expression}).disabled`, text);
  await c.evaluate(`(${expression}).click()`);
};
const input = (selector, value) => c.evaluate(`(()=>{const e=document.querySelector(${q(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${q(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const api = route => c.evaluate(`fetch(${q("/api/" + route)}).then(r=>r.json())`);
const back = () => c.evaluate(`window.dispatchEvent(new Event('nex-android-back'))`);
const section = text => button(text, "document.querySelector('.preferences-nav')");
const check = (name, condition = true) => { assert.ok(condition, name); cases.push(name); };
try {
  await wait("!!document.querySelector('.workspace-account-name')");
  // Refuse to exercise any account other than the disposable one.
  assert.equal((await api("auth/status")).account.displayName, "演示账号");
  if (!await c.evaluate("!!document.querySelector('.preferences-nav')")) {
    await click(".mobile-menu"); await click(".workspace-account-name"); await button("设置", "document.querySelector('.account-menu')");
  }
  await section("账号与登录设备");
  await wait("document.querySelectorAll('.ds-session-item').length >= 2");
  check("account settings, current session and username initial", await c.evaluate("document.querySelector('.preferences-account .account-avatar').textContent==='演' && !!document.querySelector('.ds-session-item.is-current')"));
  check("old account subtitle removed", !await c.evaluate("document.body.innerText.includes('个人工作空间')"));
  await section("模型");
  await wait("!document.querySelector('input[name=contextWindow]').disabled");
  check("default context 256k and output 32k", await c.evaluate("document.querySelector('input[name=contextWindow]').placeholder.includes('256,000')&&document.querySelector('input[name=maxOutputTokens]').placeholder.includes('32,000')"));
  await input("input[name=apiKey]", "synthetic-only"); await click("[aria-label='显示 API Key']");
  check("API key reveal", await c.evaluate("document.querySelector('input[name=apiKey]').type==='text'"));
  await input("input[name=contextWindow]", "256000"); await input("input[name=maxOutputTokens]", "32000");
  await button("保存配置"); await wait("!!document.querySelector('.preferences-saved')");
  check("model configuration saved through native authenticated transport");
  await button("获取模型列表"); await wait("document.querySelector('[data-model-settings] [role=status]')?.textContent.includes('已获取')");
  check("provider model list using saved credential");
  await section("长期记忆");
  await wait("!!document.querySelector('input[name=personalMemoryEnabled]:not(:disabled)')");
  check("global memory switch and total usage", await c.evaluate("document.querySelectorAll('[data-memory-dashboard] input[type=checkbox]').length===1 && !!document.querySelector('[data-memory-total]') && !document.querySelector('[data-memory-plugin]')"));
  await section("连接器"); await button("添加连接器");
  await input(".connector-modal input[name=name]", "演示知识库"); await input(".connector-modal input[name=url]", fixture.mcp + "/mcp");
  await button("保存连接器"); await wait("!!document.querySelector('.connector-detail')");
  await button("测试连接"); await wait("document.querySelector('.connection-status').textContent==='连接测试通过'");
  check("MCP connector create and discover tools", (await api("state")).connectors.some(x => x.name === "演示知识库" && x.tools.length));
  await section("设备"); await wait("document.body.innerText.includes('本设备')");
  check("signed-in devices and current phone marker");
  await click(".mobile-menu"); await click(".workspace-account-name"); await button("切换深色模式", "document.querySelector('.account-menu')");
  check("manual dark theme", await c.evaluate("document.querySelector('.rk-workspace').dataset.dark==='1'"));
  await click(".workspace-account-name"); await button("切换浅色模式", "document.querySelector('.account-menu')");
  await click("[aria-label='添加 Agent']");
  await input(".modal input[name=name]", "手机助手 " + Date.now().toString().slice(-4)); await input(".modal textarea[name=instructions]", "整理每天的工作");
  await button("保存", "document.querySelector('.modal')"); await wait("document.querySelector('.contact-title-row')?.textContent.includes('手机助手')");
  check("create assistant");
  await click(".contact-heading.clickable"); await button("设置", "document.querySelector('.inspector-tabs')");
  await click(".bot-identity-link"); await input(".bot-identity-editor textarea", "协助整理资料，简洁回答。");
  await button("保存", "document.querySelector('.bot-identity-editor')"); await wait("document.querySelector('.bot-identity-link')?.textContent==='协助整理资料，简洁回答。'");
  check("inline bot identity editing");
  await click(".profile-avatar-button"); await wait("!!document.querySelector('.avatar-picker')");
  await button("经典图库", "document.querySelector('.avatar-picker')");
  check("shared avatar collection", await c.evaluate("document.querySelectorAll('.avatar-option').length>=20"));
  await back();
  await button("工作", "document.querySelector('.inspector-tabs')"); await click("[aria-label='添加例行任务']");
  await input(".modal input[name=name]", "每日整理"); await input(".modal textarea[name=prompt]", "整理今日进度"); await input(".modal input[name=localTime]", "23:55");
  await button("保存", "document.querySelector('.modal')"); await wait("!!document.querySelector('.routine-toggle')");
  await click(".routine-toggle"); await wait("document.querySelector('.routine-toggle')?.getAttribute('aria-checked')==='false'");
  check("routine creation and pause");
  await click("[aria-label='收起助手详情']"); await click(".composer-add"); await button("权限", "document.querySelector('.composer-command-menu')");
  await button("完全权限", "document.querySelector('.permission-popover')");
  await click(".composer-add");
  await wait("document.querySelector('.composer-command-menu')?.textContent.includes('完全权限')");
  await back();
  check("full permission mode saves");
  await click(".composer-add");
  check("plus menu includes files permissions model and export", await c.evaluate("['文件','权限','模型','导出'].every(t=>document.querySelector('.composer-popover:popover-open')?.textContent.includes(t))"));
  await back();
  check("Back closes menu state", await c.evaluate("document.querySelector('.composer-add').getAttribute('aria-expanded')==='false'"));
  await click(".composer-add"); await c.evaluate("[...document.querySelectorAll('.composer-command-menu button')].find(b=>b.querySelector('small')?.textContent==='model').click()");
  await wait("[...document.querySelectorAll('.model-picker-popover [role=option]')].some(b=>b.textContent==='fixture-reasoning')");
  check("composer opens model selector without settings", await c.evaluate("!document.querySelector('.preferences-nav') && !!document.querySelector('[aria-label=搜索模型]')"));
  await c.evaluate("[...document.querySelectorAll('.model-picker-popover [role=option]')].find(el=>el.textContent==='fixture-reasoning').click()");
  await wait("!document.querySelector('.model-picker-popover')");
  await new Promise(resolve=>setTimeout(resolve,500));
  check("selected model saved per assistant", (await api("state")).bots.some(b=>String(b.name).startsWith('手机助手') && b.selected_model==='fixture-reasoning'));
  check("mobile layout has no horizontal overflow", await c.evaluate("document.documentElement.scrollWidth<=innerWidth"));
  writeFileSync(path.join(path.dirname(fixtureFile), "smoke-result.json"), JSON.stringify({ passed: true, cases }, null, 2));
  console.log(JSON.stringify({ passed: true, cases }, null, 2));
} catch (error) {
  writeFileSync(path.join(path.dirname(fixtureFile), "smoke-failure.txt"), await c.evaluate("document.body.innerText"));
  console.error(JSON.stringify({ passed: false, cases })); throw error;
} finally { c.close(); }
