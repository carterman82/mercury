import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../shared/types';
import { workSeconds } from './work-timing';
import { ThinkingPanel } from './ThinkingPanel';

const message: ChatMessage = { id: 'reply', role: 'assistant', content: 'Let me check.', startedAt: 1000, thinkingEndedAt: 2000, completedAt: 31000 };
afterEach(() => vi.useRealTimers());

it('includes tools, queueing, subagents and final streaming after the first text output', () => {
  expect(workSeconds(message, false, 999000)).toBe(30);
  expect(workSeconds(message, true, 16000)).toBe(15);
  expect(workSeconds({ ...message, thinkingEndedAt: 3000 }, false, 999000)).toBe(30);
});
it('freezes finished, failed and stopped replies at their saved end time, including after reload', () => {
  const restored = JSON.parse(JSON.stringify(message));
  expect(workSeconds(restored, false, Date.now())).toBe(30);
  expect(workSeconds({ ...restored, content: '' }, false, Date.now())).toBe(30);
});
it('does not invent elapsed time for legacy or interrupted replies without a known endpoint', () => {
  expect(workSeconds({ ...message, startedAt: undefined }, false, Date.now())).toBeNull();
  expect(workSeconds({ ...message, completedAt: undefined }, false, Date.now())).toBeNull();
  expect(workSeconds({ ...message, completedAt: NaN }, false, Date.now())).toBeNull();
});
it('handles time zero, subsecond responses and clock adjustments without negative duration', () => {
  expect(workSeconds({ ...message, startedAt: 0, completedAt: 999 }, false, 0)).toBe(0);
  expect(workSeconds({ ...message, completedAt: 0 }, false, 0)).toBe(0);
});
it('shows completed work duration even without model-provided reasoning', () => {
  const html = renderToStaticMarkup(<ThinkingPanel message={message} active={false} />);
  expect(html).toContain('Worked for 30s'); expect(html).not.toContain('Thought for');
});
it('keeps the active work timer running after text begins', () => {
  vi.useFakeTimers(); vi.setSystemTime(21000);
  const html = renderToStaticMarkup(<ThinkingPanel message={message} active />);
  expect(html).toContain('Working for 20s'); expect(html).not.toContain('Thought');
});
it('omits legacy duration without reasoning and labels unknown interrupted reasoning time honestly', () => {
  expect(renderToStaticMarkup(<ThinkingPanel message={{ ...message, completedAt: undefined }} active={false} />)).toBe('');
  expect(renderToStaticMarkup(<ThinkingPanel message={{ ...message, completedAt: undefined, reasoning: 'Saved reasoning' }} active={false} />)).toContain('Work time unavailable');
});
