import { createServer } from 'node:http';
import { tokens } from '../token-estimate.ts';

/** What the stricter extraction (RETAIN_INSTRUCTION) leaves out: the assistant's narration and one-off process details. */
export const NOISE = /^(我已|我正在|正在|已为你|好的，我)|进程号|\bPID\b|\bpid[ =:]*\d+|\/tmp\/|临时文件|截图/i;
/**
 * Whether a model following the instruction records this text: always after 记住, never narration, and from the assistant
 * only a stated solution or agreement. A closed episode archive is already a digest of decisions and outcomes.
 */
export const worthKeeping = (role: string, value: string) => role === 'episode' || value.includes('记住') || (!NOISE.test(value) && (role !== 'assistant' || /解决方法|约定|结论/.test(value)));

// Synthetic responses exercise the complete provider boundary, not model quality.
export async function startFakePersonalMemory() {
  const requests: Array<Record<string, unknown>>=[];
  const scripts:Array<{action:string;args:Record<string,unknown>}|string>=[];
  // Streamed answers report the input a provider would count: the offline estimate of the request times this scale.
  let usageScale=1;
  let override: ((body: Record<string, unknown>)=>Promise<unknown>|unknown)|undefined;
  const server=createServer(async(req,res)=>{
    if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'fixture-chat'},{id:'fixture-memory'}]}));return;}
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);
    if(override){const result=await override(body);if(result!==undefined){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;}}
    const messages=body.messages as Array<{role:string;content:string}>;
    const instruction=messages.find(message=>message.role==='system')?.content??'';
    const input=messages.at(-1)?.content??'';
    let answer='已收到，继续沿用已有约束。';
    if(!body.stream){
      // Episode archive: structured JSON citing real entries of the input. History summary: {workingNote, history}.
      // A single tool result digest (no JSON in the instruction) stays plain text.
      if(instruction.includes('建立段落档案')){
        const refs=[...new Set((input.match(/entry:[0-9a-f]+/g)??[]))].slice(0,2);
        answer=JSON.stringify({title:'合成段落档案',brief:'上一段要点：已完成合成讨论，未部署。待办：验证长期记忆。',topics:['合成主题'],decisions:[{decision:'只讨论，不部署',reason:'用户要求保持只读'}],operations:[{operation:'memory.read 读取合成资料',outcome:'success',identifiers:['DOC-SYNTH-1'],detail:'读取成功'},{operation:'device.exec 保存文件',outcome:'failure',identifiers:['/tmp/synthetic.txt'],detail:'设备离线'}],openItems:['验证长期记忆'],refs,workingNote:'段落笔记：只讨论，不部署；待验证长期记忆。'});
      }else if(instruction.includes('"workingNote"'))answer=JSON.stringify({workingNote:'Core 笔记：只讨论，不部署。压缩阈值80%。尚需验证长期记忆。',history:'历史：已经讨论上下文连续性及登录问题。原文见随附 entry 引用。'});
      else if(instruction.includes('只摘要这一个工具结果'))answer='摘要：操作成功，关键数据与标识见原文引用。';
      else if(instruction.includes('你整理连续对话'))answer='工作笔记：只讨论，不部署。压缩阈值80%。尚需验证长期记忆。历史：已经讨论上下文连续性及登录问题。原文见随附 entry 引用。';
      else if(instruction.includes('从新增原文提取')){
        // Follows RETAIN_INSTRUCTION: narration and one-off process details are not recorded, an explicit 记住 always is.
        const rows=JSON.parse(input) as Array<{id:string;role:string;text:string}>;
        answer=JSON.stringify({items:rows.filter(row=>worthKeeping(row.role,row.text)).map(row=>({kind:row.role==='assistant'?'experience':'fact',title:'合成偏好与决定',content:row.text,sources:[row.id]}))});
      }else if(instruction.includes('整理主题条目')){
        // Merges the new facts into the topic's body, one line per fact; over the limit the oldest lines go (the instruction's "drop superseded content").
        const data=JSON.parse(input) as {topic:{id:string;title:string;body:string}|null;facts:Array<{id:string;content:string}>};
        const lines=[...(data.topic?.body.split('\n')??[]),...data.facts.map(fact=>fact.content)].filter((line,index,all)=>all.indexOf(line)===index);
        while(lines.length>1&&tokens(lines.join('\n'))>380)lines.shift();
        answer=JSON.stringify({topics:[{...(data.topic?{id:data.topic.id}:{}),title:data.topic?.title??data.facts[0].content.slice(0,12),summary:data.facts.at(-1)!.content.slice(0,40),body:lines.join('\n'),facts:data.facts.map(fact=>fact.id)}]});
      }else if(instruction.includes('筛选旧记忆')){
        const data=JSON.parse(input) as {items:Array<{id:string;content:string}>};
        answer=JSON.stringify({retire:data.items.filter(item=>!worthKeeping('user',item.content)).map(item=>({id:item.id,reason:'助手自述或一次性过程细节'}))});
      }
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:answer},finish_reason:'stop'}],usage:{prompt_tokens:400,completion_tokens:80,prompt_tokens_details:{cached_tokens:100}}}));return;
    }
    res.setHeader('Content-Type','text/event-stream');
    const script=scripts.shift();
    const delta=script&&typeof script!=='string'?{role:'assistant',tool_calls:[{index:0,id:'call-'+requests.length,type:'function',function:{name:'broker',arguments:JSON.stringify({action:script.action,...script.args})}}]}:{role:'assistant',content:typeof script==='string'?script:answer};
    for(const frame of [{choices:[{index:0,delta,finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:script&&typeof script!=='string'?'tool_calls':'stop'}],usage:{prompt_tokens:Math.max(400,Math.ceil(tokens(body)*usageScale)),completion_tokens:20,prompt_tokens_details:{cached_tokens:100}}}])res.write(`data: ${JSON.stringify({id:'synthetic',object:'chat.completion.chunk',...frame})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('Fixture failed');
  return {origin:`http://127.0.0.1:${address.port}`,requests,scripts,setOverride(fn:typeof override){override=fn;},setUsageScale(value:number){usageScale=value;},async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
