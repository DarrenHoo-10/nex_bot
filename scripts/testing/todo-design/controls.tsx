import { useRef, type ButtonHTMLAttributes, type CSSProperties } from 'react';

// Original React controls inspired by Aceternity's Hover Border Gradient,
// Liquid Glass and animated selection patterns, using NexBot's own tokens.
// https://ui.aceternity.com/components/hover-border-gradient
// https://ui.aceternity.com/components/liquid-glass
export function GlowButton({className='', children, ...props}: ButtonHTMLAttributes<HTMLButtonElement>) {
 return <button className={`glow-button ${className}`} {...props}><span className="glow-button-content">{children}</span></button>;
}
export function GlassSwitch({label, value, items, onChange, className=''}: {label:string;value:string;items:{id:string;label:string;count?:number}[];onChange(value:string):void;className?:string}) {
 const root=useRef<HTMLDivElement>(null), index=Math.max(0,items.findIndex(x=>x.id===value));
 return <div ref={root} className={`glass-switch ${className}`} role="group" aria-label={label} style={{'--switch-count':items.length,'--switch-index':index} as CSSProperties} onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowRight'?1:-1)+items.length)%items.length;onChange(items[next].id);root.current?.querySelectorAll('button')[next]?.focus();}}>
 <span className="glass-switch-indicator" aria-hidden="true"/>
 {items.map(item=><button type="button" key={item.id} aria-label={item.label} aria-pressed={value===item.id} onClick={()=>onChange(item.id)}><span>{item.label}</span>{item.count!==undefined&&<small>{item.count}</small>}</button>)}
 </div>;
}
