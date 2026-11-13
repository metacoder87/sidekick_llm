import { useEffect, useState } from 'react';

function SidebarIcon({ hidden }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" />
      <path d="M6 2.5v11" stroke="currentColor" />
      {hidden ? null : (
        <rect x="2.7" y="3.7" width="2.1" height="8.6" rx="0.7" fill="currentColor" />
      )}
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function MaximizeIcon({ restored }) {
  if (restored) {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <rect x="1.8" y="3.8" width="6.4" height="6.4" rx="1" stroke="currentColor" />
        <path
          d="M3.8 3.8V2.8a1 1 0 0 1 1-1h4.4a1 1 0 0 1 1 1v4.4a1 1 0 0 1-1 1h-1"
          stroke="currentColor"
        />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="8" height="8" rx="1" stroke="currentColor" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="m2.5 2.5 7 7m0-7-7 7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Always-visible app chrome: the native title bar is hidden, so this bar owns
// window dragging plus the minimize / maximize / close controls. It also keeps
// the sidebar toggle and the Experts & Options panels reachable even when the
// sidebar is collapsed.
export default function TopBar({
  isSidebarHidden,
  onToggleSidebar,
  onOpenExperts,
  expertCount = 0,
  onOpenOptions,
  windowControls,
}) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!windowControls) return undefined;

    let mounted = true;
    windowControls
      .isMaximized()
      .then((value) => {
        if (mounted) setIsMaximized(Boolean(value));
      })
      .catch(() => {
        // The window may already be closing; the icon is not worth an error.
      });

    const unsubscribe = windowControls.onMaximizedChange((value) => {
      setIsMaximized(Boolean(value));
    });

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [windowControls]);

  async function handleToggleMaximize() {
    if (!windowControls) return;
    try {
      setIsMaximized(Boolean(await windowControls.toggleMaximize()));
    } catch (_error) {
      // Ignore a closing window; the state update is cosmetic.
    }
  }

  return (
    <header
      className="topbar"
      onDoubleClick={(event) => {
        if (!event.target.closest('button')) handleToggleMaximize();
      }}
    >
      <div className="topbar__left">
        <span className="topbar__brand">Sidekick LLM</span>
        <span className="topbar__divider" aria-hidden="true" />
        <button
          type="button"
          className="topbar__icon-button"
          onClick={onToggleSidebar}
          title={isSidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
          aria-label={isSidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
          aria-pressed={!isSidebarHidden}
        >
          <SidebarIcon hidden={isSidebarHidden} />
        </button>
      </div>

      <div className="topbar__right">
        <button
          type="button"
          className="topbar__action"
          onClick={onOpenExperts}
          title="Open the AI Experts panel"
        >
          <span aria-hidden="true">⚡</span>
          <span>Experts</span>
          {expertCount > 0 ? <span className="topbar__badge">{expertCount}</span> : null}
        </button>
        <button
          type="button"
          className="topbar__action"
          onClick={onOpenOptions}
          title="Open Settings &amp; options"
        >
          <span aria-hidden="true">⚙️</span>
          <span>Options</span>
        </button>

        {windowControls ? (
          <>
            <span className="topbar__divider" aria-hidden="true" />
            <div className="topbar__window-controls">
              <button
                type="button"
                className="topbar__window-control"
                onClick={() => windowControls.minimize()}
                title="Minimize"
                aria-label="Minimize"
              >
                <MinimizeIcon />
              </button>
              <button
                type="button"
                className="topbar__window-control"
                onClick={handleToggleMaximize}
                title={isMaximized ? 'Restore' : 'Maximize'}
                aria-label={isMaximized ? 'Restore' : 'Maximize'}
              >
                <MaximizeIcon restored={isMaximized} />
              </button>
              <button
                type="button"
                className="topbar__window-control topbar__window-control--close"
                onClick={() => windowControls.close()}
                title="Close"
                aria-label="Close"
              >
                <CloseIcon />
              </button>
            </div>
          </>
        ) : null}
      </div>
    </header>
  );
}
