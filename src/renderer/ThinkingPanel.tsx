import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../shared/types';
import { Markdown } from './Markdown';

export function ThinkingPanel({ message, active }: { message: ChatMessage; active: boolean }) {
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const answering = Boolean(message.content.trim());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => { if (body.current && follow.current) body.current.scrollTop = body.current.scrollHeight; }, [message.reasoning, open]);
  if (!message.reasoning && !active) return null;
  const seconds = Math.max(0, Math.floor(((message.thinkingEndedAt ?? message.completedAt ?? now) - (message.startedAt ?? now)) / 1000));
  const thinking = active && !answering;
  const label = answering && message.reasoning ? `Thought for ${seconds}s` : active ? answering ? 'Writing response' : 'Thinking' : 'Thinking stopped';
  return <details className="thinking-panel" open={open}><summary onClick={event => { event.preventDefault(); follow.current = true; setOpen(value => !value); }}><span className={`thinking-orbit ${thinking ? 'is-active' : ''}`} aria-hidden="true">✦</span><span>{label}</span>{thinking && <span className="thinking-time">{seconds}s</span>}<span className="thinking-chevron" aria-hidden="true">⌄</span></summary>{open && <div className="thinking-body" ref={body} onScroll={() => { if (body.current) follow.current = body.current.scrollHeight - body.current.scrollTop - body.current.clientHeight < 60; }}><small>MODEL-PROVIDED REASONING</small>{message.reasoning ? <Markdown content={message.reasoning} /> : <p className="thinking-placeholder">This model hasn’t shared any reasoning yet.</p>}</div>}</details>;
}
