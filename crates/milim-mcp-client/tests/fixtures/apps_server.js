const readline = require("readline");

let refreshCount = 0;
const send = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const fail = (id, message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } })}\n`);

const views = {
  chart: {
    title: "Usage trend",
    height: 180,
    body: `<div class="chart-row" id="bars" aria-label="Interactive chart"></div>
      <div class="view-footer"><span><strong id="chart-total">42.8k</strong> tokens this week</span><button id="refresh">Refresh</button></div>`,
  },
  diagram: {
    title: "Agent flow",
    height: 156,
    body: `<div class="flow" aria-label="Tool execution diagram">
      <div class="flow-node"><span>1</span><strong>Model</strong><small>Plans call</small></div><b>&rarr;</b>
      <div class="flow-node active"><span>2</span><strong>Tool</strong><small>Returns data</small></div><b>&rarr;</b>
      <div class="flow-node"><span>3</span><strong>View</strong><small>Stays live</small></div>
    </div><div class="view-note"><i></i> Same-server bridge</div>`,
  },
  form: {
    title: "Run configuration",
    height: 196,
    body: `<form class="config-form">
      <label><span>Model</span><select id="form-model"><option>GPT-5.5</option><option>Claude Opus</option></select></label>
      <label><span>Iterations</span><input id="form-iterations" type="number" min="1" max="20" value="6"></label>
      <div class="form-footer"><output id="form-status">Ready</output><button type="submit">Validate</button></div>
    </form>`,
  },
  dashboard: {
    title: "Provider health",
    height: 174,
    body: `<div class="metrics">
      <article><span>Latency</span><strong id="metric-latency">284 ms</strong><small class="good">-18%</small></article>
      <article><span>Success</span><strong id="metric-success">99.7%</strong><small>24h</small></article>
      <article><span>Queue</span><strong id="metric-queue">3</strong><small>jobs</small></article>
    </div><svg class="spark" viewBox="0 0 560 36" role="img" aria-label="Latency sparkline"><path d="M2 29 C45 27 60 10 105 18 S170 28 214 13 S286 8 330 18 S405 28 452 12 S520 8 558 4"/></svg>`,
  },
  viewer: {
    title: "Structured result",
    height: 156,
    body: `<div class="viewer-tabs"><strong>Result</strong><span>Metadata</span><span>Raw</span></div><pre id="json-viewer" aria-label="Structured result viewer">{
  "status": "ready",
  "files": 12,
  "changed": 3
}</pre>`,
  },
};

function appHtml(kind) {
  const view = views[kind];
  return `<!doctype html>
<html data-theme="light"><head><meta charset="utf-8"><style>
:root{color-scheme:light;--bg:#fafafc;--surface:#fff;--surface-2:#f2f3f7;--text:#17181c;--muted:#70727c;--border:#dedfe5;--accent:#6d5dfc;--accent-soft:#ece9ff;--good:#178052;--shadow:0 6px 18px rgba(21,22,28,.06)}
:root[data-theme="dark"]{color-scheme:dark;--bg:#131418;--surface:#1b1c22;--surface-2:#24262e;--text:#f2f3f7;--muted:#9a9da8;--border:#343640;--accent:#9287ff;--accent-soft:#2b274d;--good:#5bd49a;--shadow:0 8px 24px rgba(0,0,0,.22)}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text)}body{padding:12px 14px;font:12px/1.35 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;transition:background .12s ease,color .12s ease}.view-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.view-head div{display:grid;gap:1px}.view-head span{color:var(--muted);font-size:9px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.view-head h1{margin:0;font-size:13px;letter-spacing:-.01em}.view-pill{padding:3px 7px;border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--good);font-size:9px;font-weight:700;box-shadow:var(--shadow)}button,select,input{font:inherit}button{min-height:26px;padding:4px 9px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--text);font-weight:650;cursor:pointer;box-shadow:var(--shadow)}button:hover{border-color:var(--accent);color:var(--accent)}
.chart-row{display:flex;align-items:flex-end;gap:9px;height:82px;padding:4px 8px 0;border-bottom:1px solid var(--border);background:linear-gradient(to top,var(--border) 1px,transparent 1px) 0 0/100% 25%}.bar-col{display:grid;grid-template-rows:1fr 14px;align-items:end;justify-items:center;gap:3px;flex:1;height:100%}.bar-col i{display:block;width:min(34px,72%);min-height:5px;border-radius:5px 5px 2px 2px;background:linear-gradient(180deg,var(--accent),color-mix(in srgb,var(--accent) 72%,#3d32b6));box-shadow:0 5px 12px color-mix(in srgb,var(--accent) 22%,transparent)}.bar-col small{color:var(--muted);font-size:9px}.view-footer{display:flex;align-items:center;justify-content:space-between;margin-top:8px;color:var(--muted);font-size:10px}.view-footer strong{color:var(--text);font-size:12px}
.flow{display:grid;grid-template-columns:1fr 18px 1fr 18px 1fr;align-items:center}.flow>b{color:var(--muted);font-size:15px;text-align:center}.flow-node{display:grid;grid-template-columns:20px 1fr;grid-template-rows:auto auto;gap:0 6px;padding:8px;border:1px solid var(--border);border-radius:9px;background:var(--surface);box-shadow:var(--shadow)}.flow-node>span{grid-row:1/3;display:grid;place-items:center;width:20px;height:20px;margin:auto;border-radius:6px;background:var(--surface-2);color:var(--muted);font-size:9px;font-weight:800}.flow-node strong{font-size:10px}.flow-node small{color:var(--muted);font-size:8px}.flow-node.active{border-color:color-mix(in srgb,var(--accent) 52%,var(--border));background:var(--accent-soft)}.flow-node.active>span{background:var(--accent);color:#fff}.view-note{display:flex;align-items:center;gap:5px;margin-top:9px;color:var(--muted);font-size:9px}.view-note i{width:6px;height:6px;border-radius:50%;background:var(--good)}
.config-form{display:grid;grid-template-columns:1fr 120px;gap:10px}.config-form label{display:grid;gap:5px;color:var(--muted);font-size:9px;font-weight:700;text-transform:uppercase}.config-form select,.config-form input{width:100%;height:32px;padding:0 9px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);outline:none}.config-form select:focus,.config-form input:focus{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 18%,transparent)}.form-footer{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;padding-top:4px}.form-footer output{color:var(--good);font-size:10px;font-weight:650}
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.metrics article{display:grid;grid-template-columns:1fr auto;gap:2px 5px;padding:8px 9px;border:1px solid var(--border);border-radius:9px;background:var(--surface);box-shadow:var(--shadow)}.metrics span{grid-column:1/-1;color:var(--muted);font-size:9px}.metrics strong{font-size:14px;letter-spacing:-.02em}.metrics small{align-self:end;color:var(--muted);font-size:8px}.metrics .good{color:var(--good)}.spark{display:block;width:100%;height:35px;margin-top:7px}.spark path{fill:none;stroke:var(--accent);stroke-width:2;stroke-linecap:round;vector-effect:non-scaling-stroke;filter:drop-shadow(0 3px 5px color-mix(in srgb,var(--accent) 30%,transparent))}
.viewer-tabs{display:flex;align-items:center;gap:14px;height:22px;padding:0 8px;border:1px solid var(--border);border-bottom:0;border-radius:8px 8px 0 0;background:var(--surface-2);color:var(--muted);font-size:9px}.viewer-tabs strong{height:22px;padding-top:5px;border-bottom:2px solid var(--accent);color:var(--text)}#json-viewer{height:76px;margin:0;padding:8px 10px;overflow:hidden;border:1px solid var(--border);border-radius:0 0 8px 8px;background:var(--surface);color:var(--text);font:9px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;box-shadow:var(--shadow)}#security{display:none}
</style></head><body data-view="${kind}">
<header class="view-head"><div><span>MCP App fixture</span><h1>${view.title}</h1></div><b class="view-pill">Connected</b></header>
${view.body}<output id="security"></output>
<script>
const viewKind=${JSON.stringify(kind)},viewHeight=${view.height};let nextId=1;const pending=new Map();
function send(method,params){parent.postMessage({jsonrpc:'2.0',method,params},'*')}
function request(method,params){const id=nextId++;parent.postMessage({jsonrpc:'2.0',id,method,params},'*');return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}))}
function applyTheme(value){const theme=value==='dark'?'dark':'light';document.documentElement.dataset.theme=theme;document.body.dataset.theme=theme}
function drawChart(data){const values=data.values||[35,80,58],labels=data.labels||['Build','Test','Ship'],bars=document.querySelector('#bars');if(!bars)return;bars.replaceChildren(...values.map((value,index)=>{const column=document.createElement('div');column.className='bar-col';const bar=document.createElement('i');bar.style.height=String(value)+'%';const label=document.createElement('small');label.textContent=labels[index]||String(index+1);column.append(bar,label);return column}));const total=document.querySelector('#chart-total');if(total&&data.total)total.textContent=data.total}
function applyResult(result){const data=result?.structuredContent||{};document.body.dataset.refreshCount=String(result?._meta?.refreshCount??0);if(viewKind==='chart')drawChart(data);if(viewKind==='form'){const model=document.querySelector('#form-model'),iterations=document.querySelector('#form-iterations');if(model&&data.model)model.value=data.model;if(iterations&&data.iterations)iterations.value=String(data.iterations)}if(viewKind==='dashboard'){for(const key of ['latency','success','queue']){const target=document.querySelector('#metric-'+key);if(target&&data[key]!=null)target.textContent=String(data[key])}}if(viewKind==='viewer'){const target=document.querySelector('#json-viewer');if(target&&Object.keys(data).length)target.textContent=JSON.stringify(data,null,2)}}
addEventListener('message',event=>{if(event.source!==parent)return;const message=event.data;if(message?.id&&pending.has(message.id)){const item=pending.get(message.id);pending.delete(message.id);message.error?item.reject(message.error):item.resolve(message.result);return}if(message?.method==='ui/notifications/tool-result')applyResult(message.params);if(message?.method==='ui/notifications/host-context-changed')applyTheme(message.params?.theme);if(message?.method==='ui/resource-teardown'&&message.id){document.body.dataset.teardown='received';parent.postMessage({jsonrpc:'2.0',id:message.id,result:{}},'*')}});
const refresh=document.querySelector('#refresh');if(refresh)refresh.onclick=async()=>applyResult(await request('tools/call',{name:'refresh_chart',arguments:{}}));const form=document.querySelector('form');if(form)form.onsubmit=event=>{event.preventDefault();document.querySelector('#form-status').textContent='Validated'};
let parentDom='blocked',storage='blocked';try{void parent.document.body;parentDom='exposed'}catch{}try{localStorage.setItem('x','x');storage='exposed'}catch{}document.querySelector('#security').dataset.parentDom=parentDom;document.querySelector('#security').dataset.storage=storage;
request('ui/initialize',{appInfo:{name:${JSON.stringify(view.title)},version:'1'},appCapabilities:{},protocolVersion:'2026-01-26'}).then(result=>{applyTheme(result.hostContext?.theme);document.body.dataset.ready='true';send('ui/notifications/initialized',{});send('ui/notifications/size-changed',{height:viewHeight})});
</script></body></html>`;
}

function toolResult(name) {
  const kind = name === "refresh_chart" ? "chart" : name.replace(/^show_/, "");
  const structuredContent = {
    chart: { values: refreshCount ? [72, 46, 91] : [35, 80, 58], labels: ["Build", "Test", "Ship"], total: refreshCount ? "48.1k" : "42.8k" },
    diagram: { nodes: ["Model", "Tool", "View"] },
    form: { model: "GPT-5.5", iterations: 6 },
    dashboard: { latency: "284 ms", success: "99.7%", queue: 3 },
    viewer: { status: "ready", files: 12, changed: 3 },
  }[kind] || {};
  const content = [{ type: "text", text: `${views[kind]?.title || "App"} data` }];
  if (name === "show_chart") {
    content.push({ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" });
  }
  return { content, structuredContent, _meta: { refreshCount } };
}

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
      { name: "show_chart", title: "Usage trend", description: "Show a chart", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: "ui://milim.test/chart" } } },
      { name: "show_diagram", title: "Agent flow", description: "Show a diagram", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: "ui://milim.test/diagram" } } },
      { name: "show_form", title: "Run configuration", description: "Show a form", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: "ui://milim.test/form" } } },
      { name: "show_dashboard", title: "Provider health", description: "Show a dashboard", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: "ui://milim.test/dashboard" } } },
      { name: "show_viewer", title: "Structured result", description: "Show a viewer", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: "ui://milim.test/viewer" } } },
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
    return send(message.id, toolResult(message.params.name));
  }
  if (message.method === "resources/read" && message.params.uri.startsWith("ui://milim.test/")) {
    const kind = message.params.uri.slice("ui://milim.test/".length);
    if (views[kind]) {
      return send(message.id, { contents: [{ uri: message.params.uri, mimeType: "text/html;profile=mcp-app", text: appHtml(kind), _meta: { ui: { csp: {} } } }] });
    }
  }
  if (message.method === "resources/read" && message.params.uri === "ui://milim.test/bad") {
    return send(message.id, { contents: [{ uri: message.params.uri, mimeType: "text/html", text: appHtml("chart") }] });
  }
  if (message.method === "resources/read" && message.params.uri === "ui://milim.test/large") {
    return send(message.id, { contents: [{ uri: message.params.uri, mimeType: "text/html;profile=mcp-app", text: "x".repeat(5 * 1024 * 1024 + 1) }] });
  }
  fail(message.id, "not found");
});
