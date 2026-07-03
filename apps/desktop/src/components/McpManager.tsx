import { useEffect, useState } from "react";
import { deleteMcpServer, listMcpServers, MCP_PRESETS, saveMcpServer, type McpServerInfo } from "../api";
import { Cube, Plus, Trash, X } from "./icons";
import { SheetDialog } from "./SheetDialog";
import { Select, Toggle } from "./ui";
import "./McpManager.css";

type Selection = McpServerInfo | "new" | null;
type McpStatusTone = "ready" | "warning" | "error" | "off" | "draft";

function capabilitySummary(server: McpServerInfo): string {
  const caps = server.capabilities;
  if (!caps) return "tools";
  const names = [
    caps.tools ? "tools" : null,
    caps.resources ? "resources" : null,
    caps.prompts ? "prompts" : null,
  ].filter(Boolean);
  return names.length ? names.join(", ") : "no advertised capabilities";
}

function serverStatus(server: McpServerInfo): { tone: McpStatusTone; label: string; detail: string } {
  if (!server.enabled) return { tone: "off", label: "Disabled", detail: "Saved but not exposed to agent runs." };
  if (server.error) return { tone: "error", label: "Error", detail: server.error };
  if (server.connected) {
    return {
      tone: "ready",
      label: "Connected",
      detail: `${server.tool_count} tool${server.tool_count === 1 ? "" : "s"} available to agents from ${capabilitySummary(server)}.`,
    };
  }
  return { tone: "warning", label: "Not connected", detail: "Saved, but no live stdio connection is active." };
}

function argsSummary(args: string[]): string {
  if (args.length === 0) return "No arguments";
  if (args.length === 1) return args[0];
  return `${args.length} args`;
}

function noteTone(note: string): McpStatusTone {
  if (note.startsWith("Error:")) return "error";
  if (note.startsWith("Click Delete again")) return "warning";
  if (note.includes("Connecting") || note.includes("not connected")) return "warning";
  return "ready";
}

function McpListPlaceholder() {
  return (
    <div className="mcp-list-placeholder">
      <span>No MCP servers</span>
    </div>
  );
}

export function McpManager({ onClose }: { onClose: () => void }) {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [sel, setSel] = useState<Selection>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const refresh = () => listMcpServers().then(setServers);
  useEffect(() => {
    refresh();
  }, []);

  function edit(s: McpServerInfo | "new") {
    setSel(s);
    setNote(null);
    setConfirmDeleteId(null);
    if (s === "new") {
      setName("");
      setCommand("");
      setArgsText("");
      setEnabled(true);
    } else {
      setName(s.name);
      setCommand(s.command);
      setArgsText(s.args.join("\n"));
      setEnabled(s.enabled);
    }
  }

  function applyPreset(presetName: string) {
    const p = MCP_PRESETS.find((x) => x.name === presetName);
    if (!p) return;
    setConfirmDeleteId(null);
    setName(p.name);
    setCommand(p.command);
    setArgsText(p.args.join("\n"));
    if (p.note) setNote(p.note);
  }

  async function save() {
    if (!name.trim() || !command.trim()) return;
    setBusy(true);
    setConfirmDeleteId(null);
    setNote("Connecting... (first run may fetch the server package)");
    const id = sel && sel !== "new" ? sel.id : undefined;
    const args = argsText
      .split("\n")
      .map((a) => a.trim())
      .filter(Boolean);
    const saved = await saveMcpServer({ id, name: name.trim(), command: command.trim(), args, enabled });
    setBusy(false);
    if (!saved) {
      setNote("Error: Failed to save MCP server.");
      return;
    }
    await refresh();
    setSel(saved);
    setNote(
      saved.error
        ? `Error: ${saved.error}`
        : saved.connected
          ? `Connected - ${saved.tool_count} tool${saved.tool_count === 1 ? "" : "s"} available`
          : enabled
            ? "Saved, but not connected."
            : "Saved (disabled).",
    );
  }

  async function remove() {
    if (!sel || sel === "new") return;
    if (confirmDeleteId !== sel.id) {
      setConfirmDeleteId(sel.id);
      setNote(`Click Delete again to remove "${sel.name}".`);
      return;
    }
    await deleteMcpServer(sel.id);
    await refresh();
    setConfirmDeleteId(null);
    setNote(null);
    setSel(null);
  }

  const connectedCount = servers.filter((s) => s.connected).length;
  const selectedServer = sel && sel !== "new" ? sel : null;
  const selectedStatus = selectedServer ? serverStatus(selectedServer) : null;
  const selectedPreset = MCP_PRESETS.find((p) => p.name === name && p.command === command && p.args.join("\n") === argsText.trim());
  const args = argsText
    .split("\n")
    .map((a) => a.trim())
    .filter(Boolean);
  const canSave = Boolean(name.trim() && command.trim() && !busy);
  const editorTitle = sel === "new" ? "New MCP server" : name.trim() || selectedServer?.name || "Select an MCP server";

  return (
    <SheetDialog title="MCP Servers" className="sheet agents-sheet mcp-manager-sheet" onClose={onClose}>
        <div className="mcp-manager-header">
          <div className="mcp-manager-title">
            <h2>MCP Servers</h2>
            <p>
              Connect external Model Context Protocol servers (stdio). Their tools become available to the agent
              automatically. On Windows, <code>npx</code>/<code>uvx</code> resolve via the shell.
            </p>
          </div>
          <div className="mcp-manager-header-actions">
            <button className="btn-accent mcp-header-action" type="button" onClick={() => edit("new")}>
              <Plus size={14} />
              <span>Add server</span>
            </button>
            <button className="icon-btn sheet-close mcp-close" type="button" onClick={onClose} title="Close" aria-label="Close MCP servers">
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="mcp-manager-body">
          <aside className="mcp-rail" aria-label="MCP server list">
            <div className="mcp-rail-summary">
              <span>{servers.length} saved</span>
              <span>{connectedCount} connected</span>
            </div>
            <button className="mcp-rail-action" type="button" onClick={() => edit("new")}>
              <Plus size={14} />
              <span>New</span>
            </button>
            {servers.length > 0 ? (
              <div className="mcp-list" role="list">
                {servers.map((s) => {
                  const status = serverStatus(s);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={"mcp-list-row" + (selectedServer?.id === s.id ? " active" : "")}
                      onClick={() => edit(s)}
                    >
                      <span className={"mcp-status-dot " + status.tone} aria-hidden="true" />
                      <span className="mcp-row-copy">
                        <span className="mcp-row-name">{s.name}</span>
                        <span className="mcp-row-command">{s.command}</span>
                        <span className="mcp-row-foot">
                          <span>{status.label}</span>
                          <span>{s.connected ? `${s.tool_count} tools` : argsSummary(s.args)}</span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <McpListPlaceholder />
            )}
          </aside>

          <main className="mcp-detail">
            {sel ? (
              <div className="mcp-editor">
                <div className="mcp-editor-head">
                  <div>
                    <span className="mcp-editor-kicker">{sel === "new" ? "Draft server" : "Server connection"}</span>
                    <h3>{editorTitle}</h3>
                  </div>
                  <span className={"mcp-editor-state " + (selectedStatus?.tone ?? "draft")}>{selectedStatus?.label ?? "Draft"}</span>
                </div>

                <div className="mcp-impact-panel" aria-label="MCP run impact">
                  <div className="mcp-impact-item">
                    <span>Connection</span>
                    <strong>{selectedStatus?.label ?? "Draft"}</strong>
                    <em>{selectedStatus?.detail ?? "Choose a preset or enter a stdio command."}</em>
                  </div>
                  <div className="mcp-impact-item">
                    <span>Command</span>
                    <strong>{command.trim() || "Required"}</strong>
                    <em>{selectedPreset ? `${selectedPreset.name} preset` : "Manual stdio command"}</em>
                  </div>
                  <div className="mcp-impact-item">
                    <span>Arguments</span>
                    <strong>{argsSummary(args)}</strong>
                    <em>{args.length ? "Sent one per line" : "No process arguments"}</em>
                  </div>
                  <div className="mcp-impact-item">
                    <span>Tools</span>
                    <strong>{selectedServer ? `${selectedServer.tool_count} tool${selectedServer.tool_count === 1 ? "" : "s"}` : "After connect"}</strong>
                    <em>{selectedServer ? capabilitySummary(selectedServer) : "Available after save"}</em>
                  </div>
                </div>

                <section className="mcp-editor-section">
                  <div className="mcp-section-head">
                    <h4>Preset</h4>
                    <span>{selectedPreset?.name ?? "Optional"}</span>
                  </div>
                  <Select
                    value={selectedPreset?.name ?? ""}
                    placeholder="Choose a preset..."
                    options={MCP_PRESETS.map((p) => ({ label: p.name, value: p.name }))}
                    onChange={applyPreset}
                  />
                </section>

                <section className="mcp-editor-section">
                  <div className="mcp-section-head">
                    <h4>Identity</h4>
                    <span>{name.trim() || "Unnamed"}</span>
                  </div>
                  <label className="field mcp-field">
                    <span>Name</span>
                    <input className="css-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Filesystem" />
                  </label>
                </section>

                <section className="mcp-editor-section">
                  <div className="mcp-section-head">
                    <h4>Command</h4>
                    <span>{command.trim() || "Required"}</span>
                  </div>
                  <label className="field mcp-field">
                    <span>Command</span>
                    <input
                      className="css-input mcp-command-input"
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      placeholder="npx"
                    />
                  </label>
                  <label className="field mcp-field">
                    <span>Arguments (one per line)</span>
                    <textarea
                      className="instr-input mcp-args-input"
                      value={argsText}
                      onChange={(e) => setArgsText(e.target.value)}
                      placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\me\\project"}
                    />
                  </label>
                </section>

                <section className="mcp-editor-section">
                  <div className="mcp-section-head">
                    <h4>Status</h4>
                    <span>{enabled ? "Enabled" : "Disabled"}</span>
                  </div>
                  <div className="mcp-status-grid">
                    <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />
                    <span>{enabled ? "Connect and expose tools when available." : "Keep this server saved but inactive."}</span>
                  </div>
                  {note && <p className={"mcp-note " + noteTone(note)}>{note}</p>}
                </section>

                <div className="mcp-action-footer">
                  {sel !== "new" && (
                    <button className="btn-ghost danger mcp-delete-action" type="button" disabled={busy} onClick={remove}>
                      <Trash size={14} />
                      <span>{confirmDeleteId === selectedServer?.id ? "Confirm delete" : "Delete"}</span>
                    </button>
                  )}
                  <span className="spacer" />
                  <button className="btn-accent" type="button" disabled={!canSave} onClick={save}>
                    {busy ? "Connecting..." : "Save & connect"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mcp-empty-state">
                <div className="mcp-empty-icon" aria-hidden="true">
                  <Cube size={18} />
                </div>
                <h3>{servers.length ? "Select an MCP server" : "No MCP servers yet"}</h3>
                <p>
                  {servers.length
                    ? "Choose a saved server from the list, or connect another stdio tool source."
                    : "Add a preset or custom stdio command to expose external tools to agents."}
                </p>
                <button className="btn-accent mcp-header-action" type="button" onClick={() => edit("new")}>
                  <Plus size={14} />
                  <span>Add server</span>
                </button>
              </div>
            )}
          </main>
        </div>
      </SheetDialog>
  );
}
