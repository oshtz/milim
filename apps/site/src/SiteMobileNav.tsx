import { useEffect, useState } from "react";

export type SiteNavLink = {
  label: string;
  href: string;
  className?: string;
};

export function SiteMobileNav({ links }: { links: readonly SiteNavLink[] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      <button
        className="menu-toggle"
        type="button"
        aria-controls="mobile-nav"
        aria-expanded={open}
        aria-label={open ? "Close navigation" : "Open navigation"}
        data-open={open ? "" : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="menu-toggle-icon menu-toggle-icon-menu"><MenuIcon /></span>
        <span className="menu-toggle-icon menu-toggle-icon-close"><CloseIcon /></span>
      </button>
      <nav className="mobile-menu" id="mobile-nav" aria-label="Mobile primary" hidden={!open}>
        {links.map((link) => (
          <a className={link.className} href={link.href} key={link.href} onClick={() => setOpen(false)}>
            {link.label}
          </a>
        ))}
      </nav>
    </>
  );
}

function MenuIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
