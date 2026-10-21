import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../shared/types';
import { Markdown } from './Markdown';
import { workSeconds } from './work-timing';

export function ThinkingPanel({ message, active }: { message: ChatMessage; active: boolean }) {
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => { if (body.current && follow.current) body.current.scrollTop = body.current.scrollHeight; }, [message.reasoning, open]);
  const seconds = workSeconds(message, active, now);
  if (!message.reasoning && !active && seconds === null) return null;
  const label = active ? `Working${seconds === null ? '' : ` for ${seconds}s`}` : seconds === null ? 'Work time unavailable' : `Worked for ${seconds}s`;
  return <details className="thinking-panel" open={open}><summary onClick={event => { event.preventDefault(); follow.current = true; setOpen(value => !value); }}><span className={`thinking-orbit ${active ? 'is-active' : ''}`} aria-hidden="true">✦</span><span>{label}</span><span className="thinking-chevron" aria-hidden="true">⌄</span></summary>{open && <div className="thinking-body" ref={body} onScroll={() => { if (body.current) follow.current = body.current.scrollHeight - body.current.scrollTop - body.current.clientHeight < 60; }}><small>MODEL-PROVIDED REASONING</small>{message.reasoning ? <Markdown content={message.reasoning} /> : <p className="thinking-placeholder">This model hasn’t shared any reasoning.</p>}</div>}</details>;
}
