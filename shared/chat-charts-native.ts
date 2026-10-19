import { bindCharts, chartCSS, renderChart } from './chat-charts';

// App-owned code, evaluated by WebKit in an isolated content world, never by a
// script element in model HTML. Resources, navigation and page JS stay disabled.
const style = document.createElement('style'); style.textContent = chartCSS; document.head.append(style);
for (const code of document.querySelectorAll('pre > code.language-chart')) {
  const container = document.createElement('div');
  container.innerHTML = renderChart(code.textContent || '');
  code.parentElement?.replaceWith(container);
}
bindCharts(document);
// Height-only bridge in the isolated world, so expanding data on Apple resizes
// the message. It cannot access accounts, files, network or application actions.
const bridge = (window as unknown as { webkit?: { messageHandlers?: { nexChartHeight?: { postMessage: (height: number) => void } } } }).webkit?.messageHandlers?.nexChartHeight;
if (bridge) new ResizeObserver(() => bridge.postMessage(Math.ceil(document.body.getBoundingClientRect().height))).observe(document.body);
