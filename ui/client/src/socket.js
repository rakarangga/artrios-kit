// One shared WebSocket to /ws with reconnect. Consumers subscribe to parsed messages.
const listeners = new Set();
let ws = null;
let timer = null;

function connect() {
  if (ws && ws.readyState <= 1) return;
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; }
    listeners.forEach((fn) => fn(msg));
  };
  ws.onclose = () => {
    clearTimeout(timer);
    if (listeners.size) timer = setTimeout(connect, 2000);
  };
}

export function subscribe(fn) {
  listeners.add(fn);
  connect();
  return () => {
    listeners.delete(fn);
    if (!listeners.size && ws) { clearTimeout(timer); ws.close(); ws = null; }
  };
}
