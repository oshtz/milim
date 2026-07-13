const readline = require("readline");

let refreshCount = 0;
const send = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const fail = (id, message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } })}\n`);

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
body{font:14px system-ui;margin:0;padding:16px;color:CanvasText;background:Canvas}
#bars{display:flex;align-items:end;gap:10px;height:150px}.bar{width:44px;background:#6f63ff;border-radius:5px 5px 0 0}
button{margin-top:14px;padding:7px 12px}
</style></head><body>
<div id="bars" aria-label="Interactive chart"></div><button id="refresh">Refresh</button>
<output id="security"></output>
<script>
let nextId=1;const pending=new Map();
function send(method,params){parent.postMessage({jsonrpc:'2.0',method,params},'*')}
function request(method,params){const id=nextId++;parent.postMessage({jsonrpc:'2.0',id,method,params},'*');return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}))}
function draw(result){const values=result?.structuredContent?.values||[];document.body.dataset.refreshCount=String(result?._meta?.refreshCount??0);document.querySelector('#bars').innerHTML=values.map(value=>'<div class="bar" style="height:'+value+'%"></div>').join('')}
addEventListener('message',event=>{if(event.source!==parent)return;const message=event.data;if(message?.id&&pending.has(message.id)){const item=pending.get(message.id);pending.delete(message.id);message.error?item.reject(message.error):item.resolve(message.result);return}if(message?.method==='ui/notifications/tool-result')draw(message.params);if(message?.method==='ui/notifications/host-context-changed')document.body.dataset.theme=message.params?.theme||'';if(message?.method==='ui/resource-teardown'&&message.id){document.body.dataset.teardown='received';parent.postMessage({jsonrpc:'2.0',id:message.id,result:{}},'*')}});
document.querySelector('#refresh').onclick=async()=>draw(await request('tools/call',{name:'refresh_chart',arguments:{}}));
let parentDom='blocked',storage='blocked';try{void parent.document.body;parentDom='exposed'}catch{}try{localStorage.setItem('x','x');storage='exposed'}catch{}document.querySelector('#security').dataset.parentDom=parentDom;document.querySelector('#security').dataset.storage=storage;
request('ui/initialize',{appInfo:{name:'Milim fixture chart',version:'1'},appCapabilities:{},protocolVersion:'2026-01-26'}).then(result=>{document.body.dataset.theme=result.hostContext?.theme||'';send('ui/notifications/initialized',{});send('ui/notifications/size-changed',{height:410})});
</script></body></html>`;

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    const apps = message.params?.capabilities?.extensions?.["io.modelcontextprotocol/ui"];
    if (!apps?.mimeTypes?.includes("text/html;profile=mcp-app")) {
      return fail(message.id, "Apps extension was not advertised");
    }
    return send(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {}, resources: {}, extensions: { "io.modelcontextprotocol/ui": {} } },
      serverInfo: { name: "milim-apps-fixture", version: "1" },
    });
  }
  if (message.method === "tools/list") {
    return send(message.id, { tools: [
      { name: "show_chart", description: "Show a chart", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: "ui://milim.test/chart" } } },
      { name: "refresh_chart", description: "Refresh chart data", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ["app"] } } },
      { name: "large_result", description: "Return an oversized result", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ["app"] } } },
      { name: "model_only", description: "Model only", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ["model"] } } },
      { name: "bad_view", description: "Invalid MIME fixture", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://milim.test/bad", visibility: ["app"] } } },
      { name: "large_view", description: "Oversized fixture", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://milim.test/large", visibility: ["app"] } } },
    ] });
  }
  if (message.method === "tools/call") {
    if (message.params.name === "large_result") {
      return send(message.id, { content: [{ type: "text", text: "x".repeat(1024 * 1024 + 1) }] });
    }
    if (message.params.name === "refresh_chart") refreshCount += 1;
    const content = [{ type: "text", text: `Chart data ${refreshCount}` }];
    if (message.params.name === "show_chart") {
      content.push({ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" });
    }
    return send(message.id, {
      content,
      structuredContent: { values: refreshCount ? [72, 46, 91] : [35, 80, 58] },
      _meta: { refreshCount },
    });
  }
  if (message.method === "resources/read" && message.params.uri === "ui://milim.test/chart") {
    return send(message.id, { contents: [{ uri: message.params.uri, mimeType: "text/html;profile=mcp-app", text: html, _meta: { ui: { csp: {} } } }] });
  }
  if (message.method === "resources/read" && message.params.uri === "ui://milim.test/bad") {
    return send(message.id, { contents: [{ uri: message.params.uri, mimeType: "text/html", text: html }] });
  }
  if (message.method === "resources/read" && message.params.uri === "ui://milim.test/large") {
    return send(message.id, { contents: [{ uri: message.params.uri, mimeType: "text/html;profile=mcp-app", text: "x".repeat(5 * 1024 * 1024 + 1) }] });
  }
  fail(message.id, "not found");
});
