// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./api',()=>({api:fixture.api}));
import { FeishuOutboxSettings } from './FeishuOutboxSettings';
import { FeishuDeliverySettings } from './FeishuDeliverySettings';

let root:Root,container:HTMLDivElement;
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
  fixture.api.mockReset().mockImplementation(async(route:string)=>route==='feishu/deliveries'?{parts:[{
    id:'part-1',source_key:'report-1',app_id:'cli_fixture',chat_id:'oc_fixture',conversation_id:'topic-1',
    part:0,state:'needs_reconciliation',operation:'send',content:JSON.stringify({elements:[{content:'Market report fixture'}]}),
    attempts:3,first_post_at:1700000000000,dedupUntil:1700003600000,message_id:null,error:'uuid_window_expired',
  }]}:[]);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});

it('shows exact destination, segment, timestamps and card text without automatically resending',async()=>{
  await act(async()=>root.render(createElement(FeishuOutboxSettings,{revision:1})));
  expect(container.textContent).toContain('待人工对账 · 第 1 段 · oc_fixture');
  expect(container.textContent).toContain('cli_fixture');expect(container.textContent).toContain('topic-1');
  expect(container.textContent).toContain('Market report fixture');expect(container.textContent).toContain('去重截止');
  expect(fixture.api.mock.calls.every(call=>call[1]===undefined)).toBe(true);
  const form=container.querySelector('form')!;
  (form.elements.namedItem('messageId') as HTMLInputElement).value='om_verified';
  (form.elements.namedItem('evidence') as HTMLTextAreaElement).value='Checked destination and original card';
  await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  expect(fixture.api).toHaveBeenCalledWith('feishu/deliveries/reconcile',{
    id:'part-1',action:'delivered',messageId:'om_verified',evidence:'Checked destination and original card',confirmedNotDelivered:false,
  });
});

it('sends deliberate non-delivery attestation with exact part ID and shows verification errors',async()=>{
  await act(async()=>root.render(createElement(FeishuOutboxSettings,{revision:1})));
  fixture.api.mockImplementation(async(route:string)=>{if(route.endsWith('/reconcile'))throw new Error('完整卡片内容不匹配');return {parts:[]};});
  const form=container.querySelector('form')!;
  (form.elements.namedItem('action') as HTMLSelectElement).value='not_delivered';
  (form.elements.namedItem('evidence') as HTMLTextAreaElement).value='Verified absent in full chat history';
  (form.elements.namedItem('confirmedNotDelivered') as HTMLInputElement).checked=true;
  await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  expect(fixture.api).toHaveBeenCalledWith('feishu/deliveries/reconcile',expect.objectContaining({id:'part-1',action:'not_delivered',confirmedNotDelivered:true}));
  expect(container.querySelector('[role=alert]')?.textContent).toContain('完整卡片内容不匹配');
});

it('keeps reconciliation visible for local apps without shared accounts or subscriptions',async()=>{
  await act(async()=>root.render(createElement(FeishuDeliverySettings,{revision:1,onSharedAvailable:()=>{}})));
  expect(container.querySelector('[aria-label="飞书投递对账"]')).not.toBeNull();
});
