import { chartPrompt } from './chat-chart-format';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseChart, renderChart } from './chat-charts';

const chart = (data: object) => JSON.stringify(data);
describe('shared chat charts', () => {
  it('renders grouped positive/negative columns, zero and missing values', () => {
    const source = chart({ type:'bar',labels:['一','二','三'],series:[{name:'收入',values:[10,0,-5]},{name:'成本',values:[5,null,2]}] });
    const html=renderChart(source);
    expect(html.match(/<rect /g)).toHaveLength(5);
    expect(html).toContain('<td>—</td>'); expect(html).toContain('data-chart-type="bar"');
    expect(html).not.toMatch(/NaN|Infinity|height="-/);
  });
  it('keeps line gaps, supports singleton and all zero series', () => {
    const html=renderChart(chart({type:'line',labels:['a','b','c'],series:[{name:'数据',values:[2,null,4]}]}));
    expect(html.match(/<circle /g)).toHaveLength(2);
    expect(html).toMatch(/d="M[^"L]+M[^"L]+" stroke="#287bba"/);
    for (const values of [[0],[0,0]]) expect(renderChart(chart({type:'line',labels:values.map((_,i)=>String(i)),series:[{name:'数据',values}]}))).not.toMatch(/NaN|Infinity|data-chart-error/);
  });
  it('bins raw samples exactly once with inclusive maximum and equal values', () => {
    const data=parseChart(chart({type:'histogram',values:[0,1,2,3,4],bins:2}));
    expect(data.series[0].values).toEqual([2,3]); expect(data.labels).toEqual(['[0, 2)','[2, 4]']);
    expect(parseChart(chart({type:'histogram',values:[7,7,7],bins:5})).series[0].values.reduce<number>((a,b)=>a+(b||0),0)).toBe(3);
    expect(parseChart(chart({type:'histogram',values:[-4,-3,0,3,4],bins:2})).series[0].values).toEqual([2,3]);
    const full = Array.from({length:10000},(_,i)=>i/100);
    expect(parseChart(chart({type:'histogram',values:full,bins:50})).series[0].values.reduce<number>((a,b)=>a+(b||0),0)).toBe(10000);
  });
  it('renders a single nonzero pie as a circle and computes proportions', () => {
    const html=renderChart(chart({type:'pie',labels:['A','B'],values:[30,70]}));
    expect(html).toContain('30%'); expect(html).toContain('70%');
    expect(renderChart(chart({type:'pie',labels:['A','B'],values:[0,9]}))).toContain('<circle cx="260"');
  });
  it('rejects malformed, oversized, nonnumeric and misleading data', () => {
    for (const raw of [{},null,[],{type:'pie',labels:['a'],values:[-1]},{type:'pie',labels:['a'],values:[0]},
      {type:'bar',labels:['a'],series:[{name:'n',values:[1,2]}]}, {type:'bar',labels:['a'],series:[{name:'n',values:[null]}]},
      {type:'line',labels:['a'],series:[{name:'n',values:['1']}]},{type:'histogram',values:[1],bins:1.5},
      {type:'histogram',values:[1],bins:51},{type:'histogram',values:[1e15]},{type:'histogram',values:[]},
      {type:'histogram',values:Array(10001).fill(1)}]) expect(()=>parseChart(JSON.stringify(raw))).toThrow();
    expect(()=>parseChart(' '.repeat(200001))).toThrow();
    expect(()=>parseChart('{"type":"histogram","values":[1e309]}')).toThrow();
  });
  it('escapes labels, titles, units and invalid source without scripts or resources', () => {
    const attack='<img src=x onerror=alert(1)><script>boom()</script>"&';
    const html=renderChart(chart({type:'pie',title:attack,unit:attack,labels:[attack],values:[3]}));
    expect(html).not.toMatch(/<img|<script|onerror="/); expect(html).not.toContain(attack); expect(html).toContain('&lt;img');
    expect(renderChart(attack)).not.toContain('<img');
  });
  it('never throws or emits active markup while streaming incomplete JSON', () => {
    const source=chart({type:'bar',labels:['A'],series:[{name:'示例',values:[5]}]});
    for(let i=0;i<source.length;i++) expect(renderChart(source.slice(0,i))).toContain('data-chart-error');
    expect(renderChart(source)).toContain('data-chart-type="bar"');
  });
  it('bundles the same renderer for Apple and includes model instructions', () => {
    const source=chart({type:'pie',labels:['A','B'],values:[3,7]});
    let actual=''; const fakeCode={textContent:source,parentElement:{replaceWith:(node:{innerHTML:string})=>{actual=node.innerHTML;}}};
    runInNewContext(readFileSync('apps/apple/Packages/NexMarkdown/Sources/NexMarkdown/Resources/chat-charts.js','utf8'), {
      document:{createElement:()=>({}),head:{append:()=>{}},querySelectorAll:()=>[fakeCode],addEventListener:()=>{}},window:{},
    });
    expect(actual).toBe(renderChart(source));
    for(const type of ['bar','line','pie','histogram']) expect(chartPrompt).toContain(type);
    expect(chartPrompt).toContain('不编造');
  });
});
