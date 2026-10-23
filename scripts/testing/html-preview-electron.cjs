const { app, BrowserWindow } = require('electron');
const { writeFileSync, readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
app.setPath('userData', path.join(config.directory, 'electron'));
app.disableHardwareAcceleration();
const until = async (check) => { const end = Date.now() + 10000; while (!await check()) { if (Date.now() > end) throw Error('Preview condition timed out'); await new Promise(r => setTimeout(r, 80)); } };
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  const wc = window.webContents, cases = [], logs = [];
  if (config.localUi) {
    const { installLocalUi } = await import(require('node:url').pathToFileURL(path.resolve('electron/nex-client-ui.mjs')).href);
    installLocalUi(wc.session, config.localUi, () => config.origin);
  }
  wc.on('console-message', (_event, ...args) => { logs.push(String(args[1] ?? args[0])); });
  const evaluate = script => wc.executeJavaScript(script, true);
  const frames = () => wc.mainFrame.framesInSubtree.filter(frame => frame.url.startsWith('data:text/html;base64,'));
  const button = text => evaluate(`[...document.querySelectorAll('.html-preview-toolbar button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
  const set = async (source, pending = false) => { await evaluate(`window.fixture.set(${JSON.stringify(source)},${pending})`); await new Promise(r => setTimeout(r, 150)); };
  const fence = source => '```html-preview\n' + source + '\n```';
  const source = '<style>body{padding:16px}input{width:65%}output{font:600 28px system-ui;color:#385dcc}svg{display:block;margin-top:16px}</style><label>数量 <input id="quantity" type="range" min="1" max="100" value="20"></label><output id="result"></output><svg width="280" height="48"><rect id="bar" height="40" fill="#5a79eb"/></svg><canvas width="10" height="10"></canvas><script>const input=document.querySelector("input"), output=document.querySelector("output");function update(){output.textContent=input.value;document.querySelector("rect").setAttribute("width",Number(input.value)*2.8)}input.oninput=update;update();document.querySelector("canvas").getContext("2d").fillRect(0,0,10,10);window.state=1;</script>';
  try {
    await window.loadURL(config.origin); await until(() => evaluate('!!window.fixture'));
    await set(fence(source), true); assert.equal(frames().length, 0); cases.push('complete-fence-waits-for-final-reply');
    await set('```html-preview\n' + source); assert.equal(frames().length, 0); cases.push('unclosed-fence-never-executes');
    await set(fence(source)); await until(() => frames().length === 1); let frame = frames()[0];
    await until(() => frame.executeJavaScript('document.querySelector("output")?.textContent==="20"'));
    await frame.executeJavaScript('input.value="73";input.dispatchEvent(new Event("input",{bubbles:true}));window.state=73');
    assert.equal(await frame.executeJavaScript('output.textContent'), '73');
    assert.equal(await frame.executeJavaScript('document.querySelector("canvas").getContext("2d").getImageData(0,0,1,1).data[3]'), 255);
    cases.push('dom-svg-canvas-and-input');
    const routing = frame.routingId;
    await button('全屏'); await until(() => evaluate('!!document.querySelector(".html-preview-fullscreen")'));
    assert.equal(frames()[0].routingId, routing); assert.equal(await frames()[0].executeJavaScript('window.state'), 73);
    await button('退出全屏'); assert.equal(await frames()[0].executeJavaScript('window.state'), 73); cases.push('fullscreen-keeps-same-runtime');
    await set(fence(source)); assert.equal(await frames()[0].executeJavaScript('window.state'), 73); cases.push('ordinary-refresh-preserves-state');
    await evaluate('window.previousFrame=document.querySelector(".html-preview>iframe")');
    await button('重新运行'); await until(() => evaluate('window.previousFrame!==document.querySelector(".html-preview>iframe")'));
    await until(async () => { try { return frames().length === 1 && await frames()[0].executeJavaScript('window.state===1'); } catch { return false; } }); frame = frames()[0];
    await until(() => frame.executeJavaScript('window.state===1')); cases.push('rerun-resets-state');
    const isolation = await frame.executeJavaScript(`(()=>{let dom=false,storage=false;try{parent.document.body.innerHTML='escaped'}catch{dom=true}try{localStorage.setItem('fixture','x')}catch{storage=true}return {dom,storage,bridge:typeof window.nex,android:typeof window.NexAndroid,rtc:typeof window.RTCPeerConnection}})()`);
    assert.deepEqual(isolation, { dom: true, storage: true, bridge: 'undefined', android: 'undefined', rtc: 'undefined' }); cases.push('parent-storage-native-bridge-isolation');
    await frame.executeJavaScript(`fetch(${JSON.stringify(config.origin + '/leak/fetch')}).catch(()=>{});new Image().src=${JSON.stringify(config.origin + '/leak/image')};window.open(${JSON.stringify(config.origin + '/leak/popup')});`);
    await frame.executeJavaScript(`location.href=${JSON.stringify(config.origin + '/leak/navigation')}`).catch(() => {});
    await new Promise(r => setTimeout(r, 400)); assert.ok(logs.some(log => log.includes('frame-src data:'))); cases.push('network-popup-and-self-navigation-blocked');
    await evaluate(`dispatchEvent(new MessageEvent('message',{data:{channel:'nex-html-preview',type:'resize',height:1e99}}))`);
    assert.ok(await evaluate('document.querySelector(".html-preview>iframe").getBoundingClientRect().height<=900')); cases.push('forged-message-ignored');
    await button('停止'); await until(() => frames().length === 0); cases.push('stop-destroys-runtime');
    await set('');
    await set(fence(source) + '\n\n' + fence(source)); await until(() => frames().length === 2);
    await frames()[0].executeJavaScript('window.state=42'); assert.equal(await frames()[1].executeJavaScript('window.state'), 1); cases.push('two-independent-runtimes');
    writeFileSync(path.join(config.output, 'desktop.png'), (await wc.capturePage()).toPNG());
    window.setContentSize(390, 844); await new Promise(r => setTimeout(r, 250));
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true); cases.push('390px-layout');
    writeFileSync(path.join(config.output, 'mobile.png'), (await wc.capturePage()).toPNG());
    await set(fence('<script>throw Error("fixture")</script>'));
    await until(() => evaluate('document.querySelector(".html-preview-status")?.textContent==="运行出错"')); cases.push('script-error-visible');
    await set('```html\n<script>window.escaped=1</script>\n```\n\n<pre><code class="language-html-preview">bad</code></pre>');
    assert.equal(frames().length, 0); assert.equal(await evaluate('typeof window.escaped'), 'undefined'); cases.push('ordinary-html-and-forged-markup-remain-inert');
    await set(fence(source)); await until(() => frames().length === 1); await window.loadURL(config.origin); await until(() => evaluate('!!window.fixture')); await set(fence(source)); await until(() => frames().length === 1);
    assert.equal(await frames()[0].executeJavaScript('window.state'), 1); cases.push('history-source-reload');
    writeFileSync(path.join(config.directory, 'result.json'), JSON.stringify({ passed: true, cases }));
  } catch (error) { writeFileSync(path.join(config.directory, 'result.json'), JSON.stringify({ passed: false, error: error.stack, cases, logs: logs.slice(-8) })); }
  finally { window.destroy(); app.quit(); }
});
