import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelInfo } from "../api";
import { hasReasoningEffortChoices, normalizeReasoningEffortForModel, REASONING_EFFORT_LABEL, reasoningEffortDisplay, reasoningEffortOptions } from "../lib/reasoningEffort";
import { useSettings } from "../settings/store";
import { featureVisibleInMode } from "../ui/features";
import { useUiPreferences } from "../ui/store";
import { Bolt, Check, Eye, Image, PlusSquare, Search, Sparkles } from "./icons";

type ModelCap = "vision" | "reasoning" | "fast" | "image" | "video";

/** Heuristic capability tags from the model id, plus explicit media metadata. */
function caps(model: ModelInfo): ModelCap[] {
  const id = model.id;
  const s = id.toLowerCase();
  const out: ModelCap[] = [];
  if (model.capabilities?.imageInput) out.push("vision");
  if (model.capabilities?.imageOutput) out.push("image");
  if (model.capabilities?.videoOutput) out.push("video");
  if (/(vision|llava|pixtral|gpt-4o|gemini|claude-3|claude-opus|claude-sonnet|-vl|qwen2-vl)/.test(s) && !out.includes("vision")) out.push("vision");
  if (model.reasoning || /(r1|reason|qwq|o1|o3|-think|deepseek-r)/.test(s)) out.push("reasoning");
  if (/(flash|mini|haiku|turbo|instant|nano|0\.5b|1\.5b|-1b|-3b|-8b|small)/.test(s)) out.push("fast");
  return out;
}

function Star({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M12 3.5l2.6 5.6 5.9.8-4.3 4 1 6L12 17.2 6.8 19.9l1-6-4.3-4 5.9-.8z" />
    </svg>
  );
}

function Plug({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0zM12 16v6" />
    </svg>
  );
}

function Memory({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="7" ry="3" />
      <path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </svg>
  );
}

const CAP_ICON = {
  vision: { node: <Eye size={11} />, title: "Vision" },
  reasoning: { node: <Sparkles size={11} />, title: "Reasoning" },
  fast: { node: <Bolt size={11} />, title: "Fast" },
  image: { node: <Image size={11} />, title: "Image output" },
  video: { node: <Sparkles size={11} />, title: "Video output" },
} as const;

type EffortMenuState = { modelId: string; left: number; top: number };

function effortMenuPosition(modelId: string, button: HTMLElement, choiceCount: number): EffortMenuState {
  const edge = 8;
  const gap = 4;
  const width = 190;
  const height = choiceCount * 28 + 8;
  const rect = button.getBoundingClientRect();
  const left = Math.max(edge, Math.min(window.innerWidth - width - edge, rect.right - width));
  const below = rect.bottom + gap;
  const top = below + height > window.innerHeight - edge ? Math.max(edge, rect.top - gap - height) : below;
  return { modelId, left, top };
}

export function ModelPicker({
  models,
  model,
  onModel,
  onManageProviders,
  onManageMcp,
  onManageMemory,
  onClose,
}: {
  models: ModelInfo[];
  model: string;
  onModel: (id: string) => void;
  onManageProviders: () => void;
  onManageMcp: () => void;
  onManageMemory: () => void;
  onClose: () => void;
}) {
  const favorites = useSettings((s) => s.favorites);
  const favoritesOnly = useSettings((s) => s.favoritesOnly);
  const toggleFavorite = useSettings((s) => s.toggleFavorite);
  const setFavoritesOnly = useSettings((s) => s.setFavoritesOnly);
  const reasoningEffortByModel = useSettings((s) => s.reasoningEffortByModel);
  const setModelReasoningEffort = useSettings((s) => s.setModelReasoningEffort);
  const interfaceMode = useUiPreferences((s) => s.interfaceMode);
  const [q, setQ] = useState("");
  const [effortMenu, setEffortMenu] = useState<EffortMenuState | null>(null);
  const showMcp = featureVisibleInMode("mcp", interfaceMode);
  const showMemoryManager = featureVisibleInMode("memoryManager", interfaceMode);

  const groups = useMemo<Array<[string, ModelInfo[]]>>(() => {
    const query = q.trim().toLowerCase();
    let list = models;
    if (query) list = list.filter((m) => m.id.toLowerCase().includes(query));
    if (favoritesOnly) list = list.filter((m) => favorites.includes(m.id));
    const favs = list.filter((m) => favorites.includes(m.id));
    const rest = list.filter((m) => !favorites.includes(m.id));
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of rest) {
      const g = byProvider.get(m.owned_by) ?? [];
      g.push(m);
      byProvider.set(m.owned_by, g);
    }
    const out: Array<[string, ModelInfo[]]> = [];
    if (favs.length) out.push(["Favorites", favs]);
    for (const [prov, ms] of byProvider) out.push([prov, ms]);
    return out;
  }, [models, q, favorites, favoritesOnly]);

  return (
    <div className="mp">
      <div className="mp-search">
        <Search size={14} />
        <input autoFocus aria-label="Search models" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search models..." />
      </div>
      <div className="mp-list" onScroll={() => effortMenu && setEffortMenu(null)}>
        {groups.length === 0 && (
          <div className="mp-empty" role="status">
            {favoritesOnly ? "No favorites yet." : "No models - add a provider."}
          </div>
        )}
        {groups.map(([label, ms]) => (
          <div key={label} className="mp-group">
            <div className="mp-group-head">{label}</div>
            {ms.map((m) => {
              const hasEffortChoices = hasReasoningEffortChoices(m);
              const effort = normalizeReasoningEffortForModel(reasoningEffortByModel[m.id] ?? "auto", m);
              const reasoningChoices = reasoningEffortOptions(m);
              const effortOpen = effortMenu?.modelId === m.id;
              const modelCaps = caps(m).filter((cap) => cap !== "reasoning" || !hasEffortChoices);
              return (
                <div key={m.id} className={"mp-item" + (m.id === model ? " active" : "") + (effortOpen ? " effort-open" : "")}>
                  <button
                    type="button"
                    className={"mp-star" + (favorites.includes(m.id) ? " on" : "")}
                    title={favorites.includes(m.id) ? "Unfavorite" : "Favorite"}
                    aria-label={favorites.includes(m.id) ? `Remove ${m.id} from favorites` : `Add ${m.id} to favorites`}
                    aria-pressed={favorites.includes(m.id)}
                    onClick={() => toggleFavorite(m.id)}
                  >
                    <Star filled={favorites.includes(m.id)} />
                  </button>
                  <button
                    type="button"
                    className="mp-pick"
                    onClick={() => {
                      onModel(m.id);
                      onClose();
                    }}
                  >
                    <span className="mp-title">
                      <span className="mp-name">{m.id}</span>
                      {effort !== "auto" && <span className="mp-effort-label">{REASONING_EFFORT_LABEL[effort]}</span>}
                    </span>
                  </button>
                  {(modelCaps.length > 0 || hasEffortChoices) && (
                    <div className="mp-caps">
                      {modelCaps.map((c) => (
                        <span key={c} className="mp-cap" title={CAP_ICON[c].title}>
                          {CAP_ICON[c].node}
                        </span>
                      ))}
                      {hasEffortChoices && (
                        <div className="mp-effort-wrap">
                          <button
                            type="button"
                            className={"mp-effort-btn" + (effort !== "auto" ? " on" : "") + (effortOpen ? " open" : "")}
                            title="Reasoning effort"
                            aria-label={`Reasoning effort for ${m.id}: ${REASONING_EFFORT_LABEL[effort]}`}
                            aria-haspopup="menu"
                            aria-expanded={effortOpen}
                            onClick={(event) => {
                              const nextMenu = effortMenuPosition(m.id, event.currentTarget, reasoningChoices.length);
                              setEffortMenu((open) => open?.modelId === m.id ? null : nextMenu);
                            }}
                          >
                            <Sparkles size={11} fill={effort !== "auto" ? "currentColor" : "none"} />
                          </button>
                          {effortOpen && effortMenu && createPortal(
                            <div className="mp-effort-menu" role="menu" aria-label={`Reasoning effort for ${m.id}`} style={{ left: effortMenu.left, top: effortMenu.top }}>
                              {reasoningChoices.map((choice) => {
                                const display = reasoningEffortDisplay(choice, m);
                                return (
                                  <button
                                    key={choice}
                                    type="button"
                                    className={"mp-effort-choice" + (choice === effort ? " on" : "")}
                                    role="menuitemradio"
                                    aria-checked={choice === effort}
                                    onClick={() => {
                                      setModelReasoningEffort(m.id, choice);
                                      setEffortMenu(null);
                                    }}
                                  >
                                    <span className="mp-effort-check">{choice === effort && <Check size={11} />}</span>
                                    <span>{display.label}</span>
                                    <span>{display.detail}</span>
                                  </button>
                                );
                              })}
                            </div>,
                            document.body,
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="mp-foot">
        <button type="button" className={"mp-foot-toggle" + (favoritesOnly ? " on" : "")} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}>
          <span className="mp-checkbox">{favoritesOnly && <Check size={10} />}</span>
          Favorites only
        </button>
        <div className="mp-foot-actions">
          <button type="button" className="mp-foot-btn" data-testid="manage-providers" onClick={() => { onClose(); onManageProviders(); }}>
            <PlusSquare size={13} /> Providers
          </button>
          {showMcp && (
            <button type="button" className="mp-foot-btn" onClick={() => { onClose(); onManageMcp(); }}>
              <Plug size={13} /> MCP
            </button>
          )}
          {showMemoryManager && (
            <button type="button" className="mp-foot-btn" onClick={() => { onClose(); onManageMemory(); }}>
              <Memory size={13} /> Memory
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
