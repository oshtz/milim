import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";
import type { MediaResultItem } from "../src/api.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type GeneratedMediaProps = {
  item?: MediaResultItem | null;
  alt: string;
  onOpenExternal?: (url: string) => void;
};

const server = await createServer({
  root: process.cwd(),
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const { GeneratedMedia } = (await server.ssrLoadModule(
    "/src/components/GeneratedMedia.tsx",
  )) as { GeneratedMedia: ComponentType<GeneratedMediaProps> };
  const { MediaManager } = (await server.ssrLoadModule(
    "/src/components/MediaManager.tsx",
  )) as {
    MediaManager: ComponentType<{ onClose: () => void }>;
  };

  const manager = renderToStaticMarkup(
    createElement(MediaManager, { onClose: () => {} }),
  );
  assert(manager.includes('data-testid="media-generator"'), "The standalone media manager should remain reachable");
  assert(manager.includes(">image<") && manager.includes(">video<") && manager.includes(">music<"), "The media manager should expose all three kind tabs");

  const image = renderToStaticMarkup(
    createElement(GeneratedMedia, {
      item: { kind: "image", url: "https://cdn.example/image.png", mime: "image/png" },
      alt: "Generated image",
      onOpenExternal: () => {},
    }),
  );
  assert(image.includes('data-testid="generated-media-image"'), "Images should render as preview buttons");
  assert(image.includes("cursor") === false, "Rendering should not add inline cursor styles");
  assert(!image.includes("<a "), "Generated images should not navigate away when clicked");

  const video = renderToStaticMarkup(
    createElement(GeneratedMedia, {
      item: { kind: "video", url: "https://cdn.example/video.mp4", mime: "video/mp4" },
      alt: "Generated video",
    }),
  );
  assert(video.includes('data-testid="generated-media-video"'), "Videos should render as preview buttons");
  assert(video.includes("<video"), "Video thumbnails should render a video frame");
  assert(!video.includes("controls"), "Video thumbnails should stay non-playing and omit controls");

  const music = renderToStaticMarkup(
    createElement(GeneratedMedia, {
      item: { kind: "music", url: "data:audio/mpeg;base64,QUJD", mime: "audio/mpeg" },
      alt: "Generated music",
    }),
  );
  assert(music.includes('data-testid="generated-media-music"'), "Music should use its dedicated inline result");
  assert(music.includes("<audio"), "Music should render native audio controls");
  assert(music.includes("controls"), "Music audio should expose playback controls");
  assert(music.includes('preload="metadata"'), "Music should only preload metadata");

  const source = readFileSync(resolve(process.cwd(), "src/components/GeneratedMedia.tsx"), "utf8");
  assert(source.includes("<SheetDialog"), "Visual media should reuse the focus-trapped dialog");
  assert(source.includes("generated-media-stage"), "Expanded visual media should render in the contained stage");
  assert(source.includes("Open externally"), "Direct web media should retain the secondary external action");
} finally {
  await server.close();
}

export {};
