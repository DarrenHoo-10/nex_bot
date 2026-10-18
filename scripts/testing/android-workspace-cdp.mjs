import { WebSocket } from "ws";
export async function connectAndroidWorkspace(port = 9227, fixtureOrigin) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(t => fixtureOrigin ? new URL(t.url).origin === fixtureOrigin : new URL(t.url).hostname.endsWith(".nexbot.invalid"));
  if (!target) throw new Error("No bundled Android workspace on the explicitly forwarded fixture port");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let sequence = 0;
  const requests = new Map();
  socket.on("message", bytes => {
    const event = JSON.parse(bytes); const request = requests.get(event.id); if (!request) return;
    requests.delete(event.id); clearTimeout(request.timer);
    if (event.error) request.reject(new Error(event.error.message)); else request.resolve(event.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    requests.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  return { command, evaluate, close: () => socket.close() };
}
