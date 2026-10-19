/** One renderer for the web shells and the Apple isolated WebKit content world.
 * Model output is JSON data only; no options, HTML, URLs or executable callbacks. */
export type ChartSpec = { type: 'bar' | 'line' | 'pie' | 'histogram'; title?: string; xLabel?: string; yLabel?: string; unit?: string; labels?: string[]; series?: { name: string; values: (number | null)[] }[]; values?: number[]; bins?: number };
export type ChartData = { type: ChartSpec['type']; title: string; xLabel: string; yLabel: string; unit: string; labels: string[]; series: { name: string; values: (number | null)[] }[]; ranges?: [number, number][] };
const colors = ['#287bba', '#db7932', '#299583', '#9868bc', '#c45173', '#8a7f35'];
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12;
const label = (value: unknown, limit = 120): value is string => typeof value === 'string' && value.length <= limit;
const format = (n: number) => n.toLocaleString('en-US', { maximumSignificantDigits: 15 });
const axisFormat = (n: number) => Math.abs(n) >= 1e8 ? `${Number((n / 1e8).toPrecision(4))}亿` : Math.abs(n) >= 1e4 ? `${Number((n / 1e4).toPrecision(4))}万` : n !== 0 && Math.abs(n) < .001 ? n.toExponential(1) : String(Number(n.toPrecision(6)));
const fail = (): never => { throw new Error('图表数据不完整或格式不正确'); };

export function parseChart(source: string): ChartData {
  if (source.length > 200_000) return fail();
  const input: unknown = JSON.parse(source);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
  const raw = input as ChartSpec;
  if (!['bar', 'line', 'pie', 'histogram'].includes(raw.type)) return fail();
  for (const key of ['title', 'xLabel', 'yLabel', 'unit'] as const) if (raw[key] !== undefined && !label(raw[key])) return fail();
  const data: ChartData = { type: raw.type, title: raw.title || ({ bar: '柱状图', line: '折线图', pie: '饼图', histogram: '直方图' })[raw.type], xLabel: raw.xLabel || '', yLabel: raw.yLabel || '', unit: raw.unit || '', labels: [], series: [] };
  if (raw.type === 'histogram') {
    if (!Array.isArray(raw.values) || !raw.values.length || raw.values.length > 10_000 || !raw.values.every(number)) return fail();
    if (raw.bins !== undefined && (!Number.isInteger(raw.bins) || raw.bins < 1 || raw.bins > 50)) return fail();
    let min = Math.min(...raw.values), max = Math.max(...raw.values);
    if (min === max) { const pad = Math.max(0.5, Math.abs(min) * 0.01); min -= pad; max += pad; }
    const count = raw.bins ?? Math.min(20, Math.ceil(Math.sqrt(raw.values.length)));
    const step = (max - min) / count;
    if (!Number.isFinite(step) || step <= 0) return fail();
    const frequencies = Array<number>(count).fill(0);
    for (const value of raw.values) frequencies[Math.max(0, Math.min(count - 1, Math.floor((value - min) / step)))]++;
    data.ranges = Array.from({ length: count }, (_, i) => [min + i * step, i === count - 1 ? max : min + (i + 1) * step]);
    data.labels = data.ranges.map(([a, b], i) => `[${format(a)}, ${format(b)}${i === count - 1 ? ']' : ')'}`);
    data.series = [{ name: '频数', values: frequencies }]; data.yLabel ||= '频数';
    // Histogram Y is always a count; unit describes raw measurements on X only.
  } else {
    if (!Array.isArray(raw.labels) || !raw.labels.length || raw.labels.length > (raw.type === 'pie' ? 24 : 200) || !raw.labels.every(v => label(v) && v.trim().length > 0)) return fail();
    data.labels = raw.labels;
    if (raw.type === 'pie') {
      if (!Array.isArray(raw.values) || raw.values.length !== data.labels.length || !raw.values.every(v => number(v) && v >= 0) || !raw.values.some(v => v > 0)) return fail();
      data.series = [{ name: raw.title || '数值', values: raw.values }];
    } else {
      if (!Array.isArray(raw.series) || !raw.series.length || raw.series.length > 6) return fail();
      for (const series of raw.series) {
        if (!series || !label(series.name) || !series.name.trim() || !Array.isArray(series.values) || series.values.length !== data.labels.length || !series.values.every(v => v === null || number(v)) || !series.values.some(number)) return fail();
      }
      data.series = raw.series.map(s => ({ name: s.name, values: s.values }));
    }
  }
  return data;
}

export const chartCSS = `
.nex-chart{margin:12px 0;padding:16px;border:1px solid #8884;border-radius:12px;background:transparent;color:inherit;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-width:0;max-width:100%;overflow:hidden}
.nex-chart .nex-chart-title{font-size:16px;font-weight:600;margin:0 0 12px;overflow-wrap:anywhere}
.nex-chart .nex-chart-scroll{overflow-x:auto;max-width:100%;overscroll-behavior-x:contain}
.nex-chart svg{display:block;max-width:none;width:100%;min-width:480px;height:auto;color:inherit;overflow:visible}
.nex-chart svg text{fill:currentColor;font-family:inherit;font-size:12px}
.nex-chart [data-label]{cursor:crosshair;outline:none}.nex-chart [data-label]:hover,.nex-chart [data-label]:focus{filter:brightness(1.18);stroke:currentColor;stroke-width:2}
.nex-chart .nex-chart-legend{display:flex;gap:8px 16px;flex-wrap:wrap;margin:12px 0 0;overflow-wrap:anywhere}
.nex-chart .nex-chart-key{display:inline-flex;gap:6px;align-items:center;max-width:100%}.nex-chart .nex-chart-swatch{display:inline-block;width:10px;height:10px;border-radius:3px;flex-shrink:0}
.nex-chart .nex-chart-tooltip{min-height:24px;margin-top:8px;font-size:13px;overflow-wrap:anywhere}
.nex-chart details{margin-top:6px}.nex-chart summary{cursor:pointer;color:inherit;font-size:13px}
.nex-chart table{display:table;border-collapse:collapse;width:100%;margin:10px 0 0;font-size:12px}
.nex-chart th,.nex-chart td{border:1px solid #8884;padding:7px 10px;text-align:right;white-space:nowrap}.nex-chart th:first-child,.nex-chart td:first-child{text-align:left}
.nex-chart pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;font-size:12px}
`;

function plot(data: ChartData): string {
  const { type, labels, series, unit } = data;
  const fmt = (value: number) => format(value) + (type === 'histogram' ? '' : unit);
  const mark = (description: string) => `tabindex="0" role="img" aria-label="${escape(description)}" data-label="${escape(description)}"`;
  let drawing = '', width = type === 'pie' ? 520 : Math.max(580, Math.min(3600, labels.length * (type === 'bar' ? Math.max(44, series.length * 18) : 32) + 100));
  if (type === 'pie') {
    const values = series[0].values as number[], total = values.reduce((a, b) => a + b, 0);
    let angle = -Math.PI / 2;
    values.forEach((value, i) => {
      if (!value) return;
      const sweep = value / total * Math.PI * 2, end = angle + sweep;
      const description = `${labels[i]}：${fmt(value)}（${format(value / total * 100)}%）`, attributes = `${mark(description)} fill="${colors[i % colors.length]}"`;
      drawing += sweep >= Math.PI * 2 - 1e-12 ? `<circle cx="260" cy="170" r="130" ${attributes}><title>${escape(description)}</title></circle>` : `<path d="M260,170 L${260 + Math.cos(angle) * 130},${170 + Math.sin(angle) * 130} A130,130 0 ${sweep > Math.PI ? 1 : 0} 1 ${260 + Math.cos(end) * 130},${170 + Math.sin(end) * 130} Z" ${attributes}><title>${escape(description)}</title></path>`;
      angle = end;
    });
  } else {
    const values = series.flatMap(s => s.values.filter(number));
    let min = Math.min(0, ...values), max = Math.max(0, ...values);
    if (min === max) max = min + 1;
    // Round to readable axis ticks, keeping frequency ticks integral.
    const rough = (max - min) / 4, magnitude = 10 ** Math.floor(Math.log10(rough));
    const normalized = rough / magnitude;
    let step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
    if (type === 'histogram') step = Math.max(1, step);
    // Extremely small subnormal values cannot support a stable numeric axis.
    if (!Number.isFinite(step) || step <= 0) return fail();
    min = Math.floor(min / step) * step; max = Math.ceil(max / step) * step;
    const left = 78, right = width - 22, top = 28, bottom = 264;
    const y = (value: number) => bottom - (value - min) / (max - min) * (bottom - top);
    const slot = (right - left) / labels.length, x = (i: number) => left + slot * (i + .5);
    const ticks = Math.round((max - min) / step);
    for (let i = 0; i <= ticks; i++) {
      const value = min + i * step, yy = y(value);
      drawing += `<path d="M${left},${yy}H${right}" stroke="currentColor" opacity=".14"/><text x="${left - 8}" y="${yy + 4}" text-anchor="end">${escape(axisFormat(value))}</text>`;
    }
    drawing += `<path d="M${left},${y(0)}H${right}" stroke="currentColor" opacity=".5"/>`;
    labels.forEach((value, i) => {
      const short = value.length > 10 ? value.slice(0, 9) + '…' : value;
      drawing += `<text x="${x(i)}" y="284" text-anchor="end" transform="rotate(-35 ${x(i)} 284)"><title>${escape(value)}</title>${escape(short)}</text>`;
    });
    series.forEach((s, index) => {
      const color = colors[index % colors.length];
      if (type === 'line') {
        let path = '', previous = false;
        s.values.forEach((value, i) => { if (value === null) { previous = false; return; } path += `${previous ? 'L' : 'M'}${x(i)},${y(value)} `; previous = true; });
        drawing += `<path d="${path}" stroke="${color}" stroke-width="2.5" fill="none"/>`;
      }
      s.values.forEach((value, i) => {
        if (value === null) return;
        const description = `${labels[i]} · ${s.name}：${fmt(value)}`, title = `<title>${escape(description)}</title>`, attributes = `${mark(description)} fill="${color}"`;
        if (type === 'line') drawing += `<circle cx="${x(i)}" cy="${y(value)}" r="4.5" ${attributes}>${title}</circle>`;
        else {
          const groupWidth = type === 'histogram' ? slot : slot * .74, barWidth = groupWidth / series.length;
          drawing += `<rect x="${x(i) - groupWidth / 2 + index * barWidth}" y="${Math.min(y(0), y(value))}" width="${Math.max(.1, barWidth - (type === 'histogram' ? 0 : 1))}" height="${Math.abs(y(0) - y(value))}" ${attributes}>${title}</rect>`;
        }
      });
    });
    drawing += `<text x="${left}" y="16">${escape(data.yLabel + (unit && type !== 'histogram' ? `（${unit}）` : ''))}</text><text x="${right}" y="354" text-anchor="end">${escape(data.xLabel + (unit && type === 'histogram' ? `（${unit}）` : ''))}</text>`;
  }
  return `<div class="nex-chart-scroll"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 370" style="min-width:${type === 'pie' ? 260 : width}px" role="group" aria-label="${escape(data.title)}">${drawing}</svg></div>`;
}

export function renderChart(source: string): string {
  try {
    const data = parseChart(source);
    const total = data.type === 'pie' ? (data.series[0].values as number[]).reduce((a, b) => a + b, 0) : 0;
    const names = data.type === 'pie' ? data.labels : data.series.map(s => s.name);
    const legend = names.map((name, i) => `<span class="nex-chart-key"><i class="nex-chart-swatch" style="background:${colors[i % colors.length]}"></i>${escape(name)}</span>`).join('');
    const header = `<th scope="col">${escape(data.xLabel || (data.type === 'histogram' ? '区间（左闭右开，末组含上界）' : '类别'))}</th>` + data.series.map(s => `<th scope="col">${escape(s.name + (data.unit && data.type !== 'histogram' ? `（${data.unit}）` : ''))}</th>`).join('') + (total ? '<th scope="col">占比</th>' : '');
    const rows = data.labels.map((name, i) => `<tr><th scope="row">${escape(name)}</th>${data.series.map(s => `<td>${s.values[i] === null ? '—' : escape(format(s.values[i]!))}</td>`).join('')}${total ? `<td>${escape(format(data.series[0].values[i]! / total * 100))}%</td>` : ''}</tr>`).join('');
    return `<section class="nex-chart" data-chart-type="${data.type}" aria-label="${escape(data.title)}"><div class="nex-chart-title">${escape(data.title)}</div>${plot(data)}<div class="nex-chart-legend">${legend}</div><div class="nex-chart-tooltip" aria-live="polite">悬停或点选查看数值</div><details><summary>查看数据</summary><div class="nex-chart-scroll"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div></details></section>`;
  } catch {
    return `<section class="nex-chart" data-chart-error="true"><div role="status">图表数据尚未完整或格式不正确</div><details><summary>查看原始数据</summary><pre>${escape(source.slice(0, 200_000))}</pre></details></section>`;
  }
}

/** Event delegation supports mouse, touch and keyboard without model-supplied code. */
export function bindCharts(root: HTMLElement | Document): () => void {
  const show = (event: Event) => {
    const mark = (event.target as Element)?.closest?.('[data-label]');
    const chart = mark?.closest('.nex-chart'), output = chart?.querySelector('.nex-chart-tooltip');
    if (output && mark && root.contains(mark)) output.textContent = mark.getAttribute('data-label');
  };
  const events = ['pointerover', 'click', 'focusin'];
  events.forEach(e => root.addEventListener(e, show));
  return () => events.forEach(e => root.removeEventListener(e, show));
}
