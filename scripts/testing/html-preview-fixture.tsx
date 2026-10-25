import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RichText } from '../../src/personal/AgentDesktop';
import { htmlRenderMessage } from '../../shared/html-render';

function Fixture() {
  const [value, setValue] = useState(''), [pending, setPending] = useState(false);
  Object.assign(window, { fixture: { set(value: string, pending = false) { setValue(value); setPending(pending); }, render(content: string) { setValue(htmlRenderMessage(content)); setPending(false); } } });
  return <main><h1>交互内容 · 验证样例</h1><RichText value={value} pending={pending}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
