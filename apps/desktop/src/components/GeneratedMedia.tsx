import { useEffect, useState } from "react";
import {
  loadAuthenticatedMedia,
  type MediaResultItem,
} from "../api";
import { ExternalLink, Image, Volume2, X } from "./icons";
import { SheetDialog } from "./SheetDialog";
import "./GeneratedMedia.css";

function isDirectWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
export function GeneratedMedia({
  item,
  alt,
  onOpenExternal,
  onActivate,
}: {
  item?: MediaResultItem | null;
  alt: string;
  onOpenExternal?: (url: string) => void;
  onActivate?: () => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [source, setSource] = useState(item?.requires_auth ? "" : item?.url ?? "");
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    setLoadError(false);
    if (!item?.requires_auth) {
      setSource(item?.url ?? "");
      return;
    }
    const controller = new AbortController();
    let objectUrl = "";
    setSource("");
    loadAuthenticatedMedia(item.url, controller.signal)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadError(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item?.url, item?.requires_auth]);

  if (!item?.url) {
    return <div className="generated-media-placeholder"><Image size={26} /></div>;
  }

  if (item.kind === "music") {
    return (
      <div className="generated-media-audio" data-testid="generated-media-music">
        <Volume2 size={18} aria-hidden="true" />
        {source ? (
          <audio controls preload="metadata" src={source} aria-label={alt} />
        ) : (
          <span>{loadError ? "Music unavailable" : "Loading music..."}</span>
        )}
      </div>
    );
  }

  const video = item.kind === "video";
  const canOpenExternally = isDirectWebUrl(item.url);
  return (
    <>
      <button
        className="generated-media-thumbnail"
        data-testid={`generated-media-${video ? "video" : "image"}`}
        type="button"
        onClick={() => onActivate ? onActivate() : setPreviewOpen(true)}
        disabled={!source}
        aria-label={`Preview ${alt}`}
      >
        {source ? (
          video ? (
            <video src={source} muted preload="metadata" aria-label={alt} />
          ) : (
            <img src={source} alt={alt} />
          )
        ) : (
          <span>{loadError ? "Media unavailable" : "Loading media..."}</span>
        )}
      </button>

      {previewOpen && source && (
        <SheetDialog
          title={alt}
          className="generated-media-dialog"
          overlayClassName="generated-media-overlay"
          testId="generated-media-preview"
          onClose={() => setPreviewOpen(false)}
        >
          <div className="generated-media-toolbar">
            <span>{alt}</span>
            <div>
              {canOpenExternally && onOpenExternal && (
                <button
                  className="btn-ghost"
                  type="button"
                  onClick={() => onOpenExternal(item.url)}
                >
                  Open externally <ExternalLink size={14} />
                </button>
              )}
              <button
                className="icon-btn"
                type="button"
                aria-label="Close media preview"
                onClick={() => setPreviewOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
          </div>
          <div className="generated-media-stage">
            {video ? (
              <video src={source} controls autoPlay />
            ) : (
              <img src={source} alt={alt} />
            )}
          </div>
        </SheetDialog>
      )}
    </>
  );
}
