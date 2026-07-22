import type { ChatArtifact } from "../api";
import { isFileArtifact } from "./artifacts.js";

export type ArtifactPreviewKind = "html" | "markdown";

export interface ArtifactPreviewDocument {
  kind: ArtifactPreviewKind;
  source: string;
}

type ArtifactFile = {
  artifact: ChatArtifact;
  path: string;
  ext: string;
};

type ArtifactFileIndex = {
  byPath: Map<string, ArtifactFile>;
  byBasename: Map<string, ArtifactFile>;
  files: ArtifactFile[];
};

type PreviewBuildContext = {
  files: ArtifactFileIndex;
  moduleUrls: Map<string, Promise<string>>;
};

const SCRIPT_EXTENSIONS = new Set(["js", "jsx", "mjs", "ts", "tsx"]);
const TRANSPILED_EXTENSIONS = new Set(["jsx", "ts", "tsx"]);
const CSS_EXTENSIONS = new Set(["css"]);
const RESOLVE_EXTENSIONS = ["js", "jsx", "ts", "tsx", "mjs", "css"];
const BARE_IMPORT_OVERRIDES = new Map<string, string>([
  ["react", "https://esm.sh/react@18.3.1"],
  ["react-dom", "https://esm.sh/react-dom@18.3.1"],
  ["react-dom/client", "https://esm.sh/react-dom@18.3.1/client"],
  ["react/jsx-runtime", "https://esm.sh/react@18.3.1/jsx-runtime"],
  ["three", "https://esm.sh/three"],
  ["ogl", "https://esm.sh/ogl"],
]);
const REACT_PEER_DEPS = "deps=react@18.3.1,react-dom@18.3.1";
const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https: data: blob:",
  "style-src 'unsafe-inline' https: data: blob:",
  "img-src https: data: blob:",
  "font-src https: data:",
  "connect-src https: wss:",
  "media-src https: data: blob:",
  "frame-src https: data: blob:",
  "worker-src https: data: blob:",
  "form-action https:",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");
const PREVIEW_LOG_BRIDGE = `
(() => {
  const type = "milim-artifact-log";
  const format = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const send = (entry) => {
    try { parent.postMessage({ type, timestamp: Date.now(), ...entry }, "*"); } catch {}
  };
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level];
    console[level] = (...args) => {
      send({ level, message: args.map(format).join(" "), stack: args.find((arg) => arg && arg.stack)?.stack });
      original?.apply(console, args);
    };
  }
  addEventListener("error", (event) => {
    send({
      level: "error",
      message: event.message || format(event.error),
      stack: event.error?.stack,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });
  addEventListener("unhandledrejection", (event) => {
    send({ level: "error", message: "Unhandled rejection: " + format(event.reason), stack: event.reason?.stack });
  });
  let annotation = null;
  const selector = (element) => {
    if (element.id) return "#" + CSS.escape(element.id);
    const testId = element.getAttribute("data-testid");
    if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      const siblings = node.parentElement ? [...node.parentElement.children].filter((item) => item.tagName === node.tagName) : [];
      if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };
  const stopAnnotation = () => {
    if (!annotation) return;
    removeEventListener("pointerover", annotation.hover, true);
    removeEventListener("click", annotation.click, true);
    removeEventListener("keydown", annotation.key, true);
    annotation.active?.style.removeProperty("outline");
    clearTimeout(annotation.timer);
    annotation = null;
  };
  const startAnnotation = () => {
    stopAnnotation();
    const state = { active: null, timer: 0 };
    state.hover = (event) => {
      state.active?.style.removeProperty("outline");
      state.active = event.target instanceof Element ? event.target : null;
      state.active?.style.setProperty("outline", "2px solid #7c5cff", "important");
    };
    state.click = (event) => {
      if (!(event.target instanceof Element)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const element = event.target;
      const rect = element.getBoundingClientRect();
      parent.postMessage({ type: "milim-preview-annotation", value: {
        url: location.href, title: document.title, selector: selector(element),
        tag: element.tagName.toLowerCase(), id: element.id || undefined,
        testId: element.getAttribute("data-testid") || undefined,
        role: element.getAttribute("role") || undefined,
        visibleText: (element.innerText || element.textContent || "").trim().slice(0, 500),
        outerHtml: element.outerHTML.slice(0, 2048),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      } }, "*");
      stopAnnotation();
    };
    state.key = (event) => { if (event.key === "Escape") stopAnnotation(); };
    state.timer = setTimeout(stopAnnotation, 30000);
    annotation = state;
    addEventListener("pointerover", state.hover, true);
    addEventListener("click", state.click, true);
    addEventListener("keydown", state.key, true);
  };
  addEventListener("message", (event) => {
    if (event.data?.type === "milim-preview-annotation-start") startAnnotation();
    if (event.data?.type === "milim-preview-annotation-cancel") stopAnnotation();
  });
  addEventListener("pagehide", stopAnnotation);
})();`;
const PREVIEW_SCROLL_STYLE = `
html,
body {
  min-height: 100%;
  overflow: auto !important;
}`;

export async function buildArtifactPreviewDocument(
  artifact: ChatArtifact,
  artifacts: readonly ChatArtifact[] = [artifact],
): Promise<ArtifactPreviewDocument> {
  const kind = previewKindForArtifact(artifact);
  if (kind === "markdown") return { kind, source: artifact.content };

  const contextArtifacts = (artifacts.length ? artifacts : [artifact]).filter((item) => isFileArtifact(item) || item.id === artifact.id);
  const files = indexArtifactFiles(contextArtifacts);
  const entry = fileForArtifact(artifact, files);
  const ctx: PreviewBuildContext = { files, moduleUrls: new Map() };

  if (entry && isScriptFile(entry)) {
    return { kind, source: await standaloneScriptPreview(entry, ctx) };
  }
  return { kind, source: await htmlPreviewSource(artifact, entry?.path ?? artifactPath(artifact) ?? "index.html", ctx) };
}

export function previewKindForArtifact(artifact: ChatArtifact): ArtifactPreviewKind {
  const source = artifactSource(artifact);
  return source === "md" || source === "markdown" || artifact.mime === "text/markdown" ? "markdown" : "html";
}

async function standaloneScriptPreview(entry: ArtifactFile, ctx: PreviewBuildContext): Promise<string> {
  const styles = ctx.files.files
    .filter((file) => isCssFile(file))
    .map((file) => `<style data-artifact-file="${escapeAttribute(file.path)}">${escapeStyleText(rewriteCssUrls(file.artifact.content, file.path, ctx))}</style>`)
    .join("\n");
  const source = standaloneScriptBootstrap(await moduleUrlForFile(entry, ctx), entry);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    previewCspMeta(),
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    styles,
    previewScrollStyle(),
    "</head>",
    "<body>",
    '<div id="root"></div>',
    previewLogBridgeScript(),
    `<script type="module">${escapeScriptText(source)}</script>`,
    "</body>",
    "</html>",
  ].filter(Boolean).join("\n");
}

function standaloneScriptBootstrap(entryUrl: string, entry: ArtifactFile): string {
  const autoMountReact = entry.ext === "jsx" || entry.ext === "tsx";
  return [
    `const previewModule = await import(${JSON.stringify(entryUrl)});`,
    autoMountReact
      ? [
        'const root = document.getElementById("root");',
        'if (root && !root.childNodes.length && typeof previewModule.default === "function") {',
        `  const React = await import(${JSON.stringify(BARE_IMPORT_OVERRIDES.get("react"))});`,
        `  const { createRoot } = await import(${JSON.stringify(BARE_IMPORT_OVERRIDES.get("react-dom/client"))});`,
        "  createRoot(root).render(React.createElement(previewModule.default));",
        "}",
      ].join("\n")
      : "",
  ].filter(Boolean).join("\n");
}

async function htmlPreviewSource(artifact: ChatArtifact, entryPath: string, ctx: PreviewBuildContext): Promise<string> {
  let html = artifact.content;
  html = await inlineLinkedStyles(html, entryPath, ctx);
  html = await inlineScripts(html, entryPath, ctx);
  return withPreviewRuntime(withPreviewScrollStyle(withPreviewCsp(html)));
}

async function inlineLinkedStyles(html: string, entryPath: string, ctx: PreviewBuildContext): Promise<string> {
  return await replaceAsync(html, /<link\b([^>]*?)>/gi, async (tag: string, attrs: string) => {
    const href = attrValue(attrs, "href");
    const rel = attrValue(attrs, "rel");
    if (!href || !rel?.toLowerCase().split(/\s+/).includes("stylesheet")) return tag;
    const file = resolveArtifactFile(ctx.files, entryPath, href);
    if (!file || !isCssFile(file)) return tag;
    const css = rewriteCssUrls(file.artifact.content, file.path, ctx);
    return `<style data-artifact-file="${escapeAttribute(file.path)}">${escapeStyleText(css)}</style>`;
  });
}

async function inlineScripts(html: string, entryPath: string, ctx: PreviewBuildContext): Promise<string> {
  return await replaceAsync(html, /<script\b([^>]*)>([\s\S]*?)<\/script>/gi, async (tag: string, attrs: string, body: string) => {
    const src = attrValue(attrs, "src");
    if (src) {
      const file = resolveArtifactFile(ctx.files, entryPath, src);
      if (!file || !isScriptFile(file)) return tag;
      const scriptAttrs = ensureModuleScript(removeAttr(attrs, "src"));
      const source = await moduleSourceForFile(file, ctx);
      return `<script${scriptAttrs}>${escapeScriptText(source)}</script>`;
    }
    if (!isModuleScript(attrs) && !hasModuleSyntax(body)) return tag;
    const source = await compileAndRewriteModule(body, entryPath, ctx);
    return `<script${ensureModuleScript(attrs)}>${escapeScriptText(source)}</script>`;
  });
}

async function moduleUrlForFile(file: ArtifactFile, ctx: PreviewBuildContext): Promise<string> {
  const cached = ctx.moduleUrls.get(file.path);
  if (cached) return await cached;
  const pending = moduleSourceForFile(file, ctx).then((source) => `data:text/javascript;charset=utf-8;base64,${toBase64(source)}`);
  ctx.moduleUrls.set(file.path, pending);
  return await pending;
}

async function moduleSourceForFile(file: ArtifactFile, ctx: PreviewBuildContext): Promise<string> {
  if (isCssFile(file)) {
    const css = rewriteCssUrls(file.artifact.content, file.path, ctx);
    return [
      "const style = document.createElement('style');",
      `style.textContent = ${JSON.stringify(css)};`,
      "document.head.appendChild(style);",
      "export default style.textContent;",
    ].join("\n");
  }
  return await compileAndRewriteModule(file.artifact.content, file.path, ctx);
}

async function compileAndRewriteModule(source: string, path: string, ctx: PreviewBuildContext): Promise<string> {
  const compiled = await transpileSource(source, path);
  return await rewriteModuleImports(compiled, path, ctx);
}

async function transpileSource(source: string, path: string): Promise<string> {
  if (!TRANSPILED_EXTENSIONS.has(extensionOf(path))) return source;
  const ts = await import("typescript");
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: "react",
      allowJs: true,
    },
  }).outputText;
}

async function rewriteModuleImports(source: string, fromPath: string, ctx: PreviewBuildContext): Promise<string> {
  let rewritten = await replaceAsync(
    source,
    /(\b(?:import|export)\s+(?:[^'"]*?\s+from\s*)?)(["'])([^"']+)\2/g,
    async (match: string, prefix: string, quote: string, specifier: string) => {
      const resolved = await resolveModuleSpecifier(specifier, fromPath, ctx);
      return resolved === specifier ? match : `${prefix}${quote}${resolved}${quote}`;
    },
  );
  rewritten = await replaceAsync(
    rewritten,
    /(\bimport\s*\(\s*)(["'])([^"']+)\2(\s*\))/g,
    async (match: string, prefix: string, quote: string, specifier: string, suffix: string) => {
      const resolved = await resolveModuleSpecifier(specifier, fromPath, ctx);
      return resolved === specifier ? match : `${prefix}${quote}${resolved}${quote}${suffix}`;
    },
  );
  return rewritten;
}

async function resolveModuleSpecifier(specifier: string, fromPath: string, ctx: PreviewBuildContext): Promise<string> {
  if (isExternalSpecifier(specifier)) return specifier;
  const file = resolveArtifactFile(ctx.files, fromPath, specifier);
  if (file) return await moduleUrlForFile(file, ctx);
  if (isBareSpecifier(specifier)) return BARE_IMPORT_OVERRIDES.get(specifier) ?? `https://esm.sh/${specifier}?${REACT_PEER_DEPS}`;
  return specifier;
}

function rewriteCssUrls(css: string, fromPath: string, ctx: PreviewBuildContext): string {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (match, quote: string, specifier: string) => {
    if (isExternalSpecifier(specifier) || specifier.startsWith("#")) return match;
    const file = resolveArtifactFile(ctx.files, fromPath, specifier);
    if (!file) return match;
    return `url(${quote}data:${file.artifact.mime || mimeForExtension(file.ext)};base64,${toBase64(file.artifact.content)}${quote})`;
  });
}

function indexArtifactFiles(artifacts: readonly ChatArtifact[]): ArtifactFileIndex {
  const byPath = new Map<string, ArtifactFile>();
  const basenameCounts = new Map<string, number>();
  const files: ArtifactFile[] = [];
  for (const artifact of artifacts) {
    const path = artifactPath(artifact);
    if (!path) continue;
    const file = { artifact, path, ext: extensionOf(path) };
    byPath.set(path, file);
    files.push(file);
    const base = basename(path);
    basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
  }
  const byBasename = new Map<string, ArtifactFile>();
  for (const file of files) {
    const base = basename(file.path);
    if (basenameCounts.get(base) === 1) byBasename.set(base, file);
  }
  return { byPath, byBasename, files };
}

function fileForArtifact(artifact: ChatArtifact, files: ArtifactFileIndex): ArtifactFile | null {
  const path = artifactPath(artifact);
  return path ? files.byPath.get(path) ?? null : null;
}

function resolveArtifactFile(files: ArtifactFileIndex, fromPath: string, specifier: string): ArtifactFile | null {
  const basePath = specifier.startsWith("/")
    ? normalizePath(specifier)
    : normalizePath(`${dirname(fromPath)}/${specifier}`);
  if (!basePath) return files.byBasename.get(basename(specifier)) ?? null;
  for (const candidate of candidatePaths(basePath)) {
    const file = files.byPath.get(candidate);
    if (file) return file;
  }
  return files.byBasename.get(basename(specifier)) ?? null;
}

function candidatePaths(path: string): string[] {
  if (extensionOf(path)) return [path];
  return [
    path,
    ...RESOLVE_EXTENSIONS.map((ext) => `${path}.${ext}`),
    ...RESOLVE_EXTENSIONS.map((ext) => `${path}/index.${ext}`),
  ];
}

function artifactPath(artifact: ChatArtifact): string | null {
  const path = normalizePath(artifact.filename ?? artifact.title);
  if (!path || extensionOf(path)) return path;
  const source = artifactSource(artifact);
  return SCRIPT_EXTENSIONS.has(source) ? `${path}.${source}` : path;
}

function normalizePath(path: string): string | null {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) return null;
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.join("/") || null;
}

function artifactSource(artifact: ChatArtifact): string {
  return (artifact.language || extensionOf(artifact.filename ?? artifact.title)).toLowerCase();
}

function extensionOf(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized) return "";
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : "";
}

function isScriptFile(file: ArtifactFile): boolean {
  return SCRIPT_EXTENSIONS.has(file.ext);
}

function isCssFile(file: ArtifactFile): boolean {
  return CSS_EXTENSIONS.has(file.ext);
}

function isModuleScript(attrs: string): boolean {
  return attrValue(attrs, "type")?.toLowerCase() === "module";
}

function hasModuleSyntax(source: string): boolean {
  return /^\s*(import|export)\s/m.test(source);
}

function ensureModuleScript(attrs: string): string {
  return isModuleScript(attrs) ? attrs : `${attrs} type="module"`;
}

function removeAttr(attrs: string, name: string): string {
  return attrs.replace(new RegExp(`\\s+\\b${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i"), "");
}

function attrValue(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function isExternalSpecifier(specifier: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(specifier);
}

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !isExternalSpecifier(specifier);
}

function mimeForExtension(ext: string): string {
  if (ext === "css") return "text/css";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "js" || ext === "mjs" || ext === "jsx" || ext === "ts" || ext === "tsx") return "text/javascript";
  return "text/plain";
}

async function replaceAsync(
  source: string,
  pattern: RegExp,
  replacer: (...args: string[]) => Promise<string>,
): Promise<string> {
  const parts: string[] = [];
  let lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    parts.push(source.slice(lastIndex, match.index));
    parts.push(await replacer(...(match as unknown as string[])));
    lastIndex = (match.index ?? 0) + match[0].length;
  }
  parts.push(source.slice(lastIndex));
  return parts.join("");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeScriptText(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

function escapeStyleText(value: string): string {
  return value.replace(/<\/style/gi, "<\\/style");
}

function previewCspMeta(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(PREVIEW_CSP)}" />`;
}

function previewLogBridgeScript(): string {
  return `<script data-milim-artifact-log-bridge>${escapeScriptText(PREVIEW_LOG_BRIDGE)}</script>`;
}

function previewScrollStyle(): string {
  return `<style data-milim-artifact-scroll>${escapeStyleText(PREVIEW_SCROLL_STYLE)}</style>`;
}

function withPreviewRuntime(html: string): string {
  if (html.includes("data-milim-artifact-log-bridge")) return html;
  const script = previewLogBridgeScript();
  if (/<script\b/i.test(html)) return html.replace(/<script\b/i, `${script}\n<script`);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${script}\n</head>`);
  if (/<body\b[^>]*>/i.test(html)) return html.replace(/<body\b[^>]*>/i, (body) => `${body}\n${script}`);
  return html.replace(/<html\b[^>]*>/i, (tag) => `${tag}\n${script}`);
}

function withPreviewScrollStyle(html: string): string {
  if (html.includes("data-milim-artifact-scroll")) return html;
  const style = previewScrollStyle();
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${style}\n</head>`);
  if (/<body\b[^>]*>/i.test(html)) return html.replace(/<body\b[^>]*>/i, (body) => `<head>\n${style}\n</head>\n${body}`);
  return `${style}\n${html}`;
}

function withPreviewCsp(html: string): string {
  if (/<meta\b[^>]*http-equiv\s*=\s*(?:"content-security-policy"|'content-security-policy'|content-security-policy)/i.test(html)) return html;
  const meta = previewCspMeta();
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (head) => `${head}\n${meta}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (tag) => `${tag}\n<head>\n${meta}\n</head>`);
  return ["<!doctype html>", '<html lang="en">', "<head>", meta, "</head>", "<body>", html, "</body>", "</html>"].join("\n");
}

function toBase64(value: string): string {
  const buffer = (globalThis as unknown as { Buffer?: { from(input: string, encoding: string): { toString(encoding: string): string } } }).Buffer;
  if (buffer) return buffer.from(value, "utf8").toString("base64");
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}
