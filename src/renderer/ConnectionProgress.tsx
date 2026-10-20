import React, { useEffect, useRef } from 'react';

export function ConnectionProgress({ message, browserSignIn, onCancel }: { message: string; browserSignIn: boolean; onCancel?: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { requestAnimationFrame(() => { if (previous?.isConnected) previous.focus(); }); };
  }, []);
  return <div className="connection-progress-backdrop"><div className="connection-progress" role="dialog" aria-modal="true" aria-labelledby="connection-progress-title" tabIndex={-1} ref={panel} onKeyDown={event => {
    if (event.key === 'Tab') { event.preventDefault(); (panel.current?.querySelector('button') ?? panel.current)?.focus(); }
    if (event.key === 'Escape' && onCancel) onCancel();
  }}>
    <span className="connection-spinner" aria-hidden="true" />
    <div role="status" aria-live="polite"><h3 id="connection-progress-title">{message}</h3><p>{browserSignIn ? 'Finish signing in in your browser. This window will update when you return.' : 'This may take a moment. Mercury is still working.'}</p></div>
    {onCancel && <button autoFocus onClick={onCancel}>Cancel sign-in</button>}
  </div></div>;
}
