import { createServer } from 'node:http';
import { tokens } from '../token-estimate.ts';

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
      if(instruction.includes('你整理连续对话'))answer='工作笔记：只讨论，不部署。压缩阈值80%。尚需验证长期记忆。历史：已经讨论上下文连续性及登录问题。原文见随附 entry 引用。';
      else if(instruction.includes('从新增原文提取')){
        const rows=JSON.parse(input) as Array<{id:string;role:string;text:string}>;
        answer=JSON.stringify({items:rows.map(row=>({kind:row.role==='assistant'?'experience':'fact',title:'合成偏好与决定',content:row.text,sources:[row.id]}))});
      }else if(instruction.includes('合并同一事项')){
        const data=JSON.parse(input);
        answer=JSON.stringify({items:data.facts.map((fact:{content:string;refs_json:string})=>({title:'当前约束',content:fact.content,sources:JSON.parse(fact.refs_json).map((ref:{id:string})=>ref.id)}))});
      }else if(instruction.includes('维护三个文档')){
        const data=JSON.parse(input);
        answer=JSON.stringify({documents:[{title:'重要决定',content:data.evidence.map((row:{content:string})=>row.content).join('\n'),sources:[...new Set(data.evidence.flatMap((row:{refs_json:string})=>JSON.parse(row.refs_json).map((ref:{id:string})=>ref.id)))]}]});
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
