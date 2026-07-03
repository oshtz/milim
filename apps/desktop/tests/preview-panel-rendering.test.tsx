import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import type { ChatArtifact } from "../src/api.js";

type PreviewPanelProps = {
  artifact: ChatArtifact;
  artifacts?: readonly ChatArtifact[];
  onClose: () => void;
  onOpenBrowser?: () => void;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const urlArtifact: ChatArtifact = {
  id: "url-preview",
  kind: "text",
  title: "http://localhost:5173/",
  mime: "text/uri-list",
  content: "http://localhost:5173/",
  size: 22,
  language: "url",
};

const blankUrlArtifact: ChatArtifact = {
  id: "blank-url-preview",
  kind: "text",
  title: "Browser",
  mime: "text/uri-list",
  content: "",
  size: 0,
  language: "url",
};

const htmlArtifact: ChatArtifact = {
  id: "html-preview",
  kind: "code",
  title: "index.html",
  filename: "index.html",
  language: "html",
  mime: "text/html",
  content: "<!doctype html><html><body>Preview</body></html>",
  size: 48,
};

const server = await createServer({
  root: process.cwd(),
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const { PreviewPanel } = await server.ssrLoadModule("/src/components/PreviewPanel.tsx") as {
    PreviewPanel: ComponentType<PreviewPanelProps>;
  };
  const urlMarkup = renderToStaticMarkup(createElement(PreviewPanel, { artifact: urlArtifact, onClose: () => {} }));
  assert(urlMarkup.includes('data-testid="preview-browser-bar"'), "URL artifacts should render browser chrome");
  assert(urlMarkup.includes('data-testid="preview-browser-url"'), "URL artifacts should render an address input");
  assert(urlMarkup.includes('data-testid="preview-native-browser"'), "URL artifacts should render the native browser host");
  assert(urlMarkup.includes('src="http://localhost:5173/"'), "URL artifacts should render a non-Tauri iframe fallback");

  const blankUrlMarkup = renderToStaticMarkup(createElement(PreviewPanel, { artifact: blankUrlArtifact, onClose: () => {} }));
  assert(blankUrlMarkup.includes('data-testid="preview-browser-bar"'), "Blank URL artifacts should still render browser chrome");
  assert(blankUrlMarkup.includes('data-testid="preview-browser-empty"'), "Blank URL artifacts should render the empty browser state");

  const htmlMarkup = renderToStaticMarkup(createElement(PreviewPanel, { artifact: htmlArtifact, onClose: () => {}, onOpenBrowser: () => {} }));
  assert(!htmlMarkup.includes('data-testid="preview-browser-bar"'), "HTML artifacts should not render browser chrome");
  assert(htmlMarkup.includes('data-testid="preview-open-browser"'), "HTML artifacts should let users switch to the browser");
  assert(htmlMarkup.includes("srcDoc="), "HTML artifacts should keep srcDoc preview rendering");
} finally {
  await server.close();
}

export {};
