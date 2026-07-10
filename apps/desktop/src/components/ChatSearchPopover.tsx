import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { wireMessageContent } from "../api";
import { searchChatSessions, type SearchableChatSession } from "../lib/chatSearch";
import { sessionRecencyLabel } from "../lib/sessionRecency";
import { useSessions, type Project } from "../sessions/store";
import { Search, X } from "./icons";

export function ChatSearchPopover({
  projects,
  activeId,
  onSelect,
  onClose,
}: {
  projects: Project[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const sessions = useSessions((s) => s.sessions);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchableSessions = useMemo<SearchableChatSession[]>(
    () => sessions.map((session) => ({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      archivedAt: session.archivedAt,
      settings: session.settings,
      messages: session.messages.map((message) => ({
        role: message.role,
        content: wireMessageContent(message),
      })),
    })),
    [sessions],
  );
  const results = useMemo(
    () => searchChatSessions(searchableSessions, projects, query),
    [projects, query, searchableSessions],
  );
  const activeIndex = results.length ? Math.min(selectedIndex, results.length - 1) : 0;
  const selected = results[activeIndex] ?? null;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  function openSelected() {
    if (!selected) return;
    onSelect(selected.sessionId);
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current) => results.length ? (current + 1) % results.length : 0);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => results.length ? (current - 1 + results.length) % results.length : 0);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      openSelected();
    }
  }

  return (
    <div className="chat-search-overlay" data-native-preview-blocker="true" role="dialog" aria-modal="true" aria-label="Search chats" onKeyDown={handleKeyDown}>
      <div className="chat-search-popover">
        <div className="chat-search-head">
          <Search size={15} />
          <input
            ref={inputRef}
            data-testid="chat-search-input"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search chats"
            aria-label="Search chats"
          />
          <button className="chat-search-close" type="button" aria-label="Close search" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="chat-search-list" data-testid="chat-search-results" role="listbox" aria-label="Chat search results">
          {results.length === 0 ? (
            <div className="chat-search-empty">{query.trim() ? "No chats found" : "No recent chats"}</div>
          ) : (
            results.map((result, index) => {
              const active = index === activeIndex;
              const metadata = [sessionRecencyLabel(result.updatedAt), result.metadata].filter(Boolean).join(" | ");
              return (
                <button
                  key={result.sessionId}
                  className={"chat-search-result" + (active ? " active" : "") + (result.sessionId === activeId ? " current" : "")}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-testid="chat-search-result"
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => {
                    onSelect(result.sessionId);
                    onClose();
                  }}
                >
                  <span className="chat-search-result-title">{result.title}</span>
                  <span className="chat-search-result-meta">{metadata}</span>
                  <span className="chat-search-result-snippet">{result.snippet}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
