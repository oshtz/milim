import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { clampContextMenuPosition, shouldPreserveNativeContextMenu, type ContextMenuPoint } from "../lib/contextMenu";
import { Check } from "./icons";

export type ContextMenuItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  detail?: string;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  separatorBefore?: boolean;
  action: () => void | Promise<void>;
};

type ContextMenuState = {
  point: ContextMenuPoint;
  items: ContextMenuItem[];
  label?: string;
};

type ContextMenuApi = {
  openContextMenu: (event: MouseEvent, items: ContextMenuItem[], label?: string) => boolean;
  closeContextMenu: () => void;
};

const ContextMenuContext = createContext<ContextMenuApi | null>(null);
const ESTIMATED_MENU_SIZE = { width: 240, height: 260 };

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [position, setPosition] = useState<ContextMenuPoint | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const closeContextMenu = useCallback(() => setMenu(null), []);

  const openContextMenu = useCallback((event: MouseEvent, items: ContextMenuItem[], label?: string) => {
    if (event.defaultPrevented || shouldPreserveNativeContextMenu(event.target) || items.length === 0) return false;
    event.preventDefault();
    event.stopPropagation();
    const point = { x: event.clientX, y: event.clientY };
    setMenu({ point, items, label });
    setPosition(clampContextMenuPosition(point, ESTIMATED_MENU_SIZE, { width: window.innerWidth, height: window.innerHeight }));
    return true;
  }, []);

  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const next = clampContextMenuPosition(menu.point, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight });
    setPosition((current) => current && current.x === next.x && current.y === next.y ? current : next);
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeContextMenu();
    }
    function onPointerDown(event: PointerEvent) {
      if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) return;
      closeContextMenu();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", closeContextMenu);
    window.addEventListener("resize", closeContextMenu);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", closeContextMenu);
      window.removeEventListener("resize", closeContextMenu);
    };
  }, [closeContextMenu, menu]);

  const api = useMemo(() => ({ openContextMenu, closeContextMenu }), [closeContextMenu, openContextMenu]);

  return (
    <ContextMenuContext.Provider value={api}>
      {children}
      {menu && position && createPortal(
        <div
          ref={menuRef}
          className="app-context-menu"
          data-testid="app-context-menu"
          role="menu"
          aria-label={menu.label ?? "Context menu"}
          style={{ left: position.x, top: position.y }}
        >
          {menu.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`app-context-menu-item${item.danger ? " danger" : ""}${item.separatorBefore ? " sep-before" : ""}`}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                closeContextMenu();
                void item.action();
              }}
            >
              <span className="app-context-menu-icon" aria-hidden="true">
                {item.checked ? <Check size={13} /> : item.icon}
              </span>
              <span className="app-context-menu-label">{item.label}</span>
              {item.detail && <span className="app-context-menu-detail">{item.detail}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </ContextMenuContext.Provider>
  );
}

export function useContextMenu(): ContextMenuApi {
  const api = useContext(ContextMenuContext);
  if (!api) throw new Error("useContextMenu must be used inside ContextMenuProvider");
  return api;
}
