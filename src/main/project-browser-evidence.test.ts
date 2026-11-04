import { expect, it } from 'vitest';
import { newHandoff, recordProjectAction } from './project-progress';

const url = 'http://127.0.0.1:4173';
function opened() {
  const handoff = newHandoff(undefined, 'Verify page');
  recordProjectAction(handoff, 'browser_open', {}, { url, errors: [] }, 'open', 1);
  handoff.browser!.modelReady = true;
  return handoff;
}

it.each(['browser_pointer', 'browser_press', 'browser_fill', 'browser_click_button', 'browser_act'])('%s invalidates an observation and captures readiness at interaction', name => {
  const handoff = opened();
  recordProjectAction(handoff, name, {}, { url }, 'interaction', 2);
  expect(handoff.browser).toMatchObject({ interacted: true, observed: false, interactedAt: 2, readyAtInteraction: true });
  expect(handoff.browser!.observationId).toBeUndefined();
});

it.each(['browser_read', 'browser_screenshot'])('%s observes only the current page after interaction', name => {
  const handoff = opened();
  recordProjectAction(handoff, 'browser_click_button', {}, { url }, 'click', 2);
  recordProjectAction(handoff, name, {}, { url: url + '/other' }, 'other', 3);
  expect(handoff.browser!.observed).toBe(false);
  recordProjectAction(handoff, name, {}, { url }, 'observed', 4);
  expect(handoff.browser).toMatchObject({ observed: true, observationId: 'observed' });
});

it.each(['browser_search', 'browser_click', 'browser_close', 'browser_wait', 'browser_enable_controls'])('%s preserves existing interaction and observation state', name => {
  const handoff = opened();
  recordProjectAction(handoff, 'browser_click_button', {}, { url }, 'click', 2);
  recordProjectAction(handoff, 'browser_read', {}, { url }, 'read', 3);
  const before = structuredClone(handoff.browser);
  recordProjectAction(handoff, name, {}, { url }, 'passive', 4);
  expect(handoff.browser).toEqual(before);
});

it('keeps selected-read, failed-result and newly submitted reply behavior', () => {
  const handoff = opened();
  recordProjectAction(handoff, 'browser_read', {}, { url, selected: { selector: '#status', text: 'Model ready' } }, 'ready', 2);
  expect(handoff.browser!.observationId).toBe('ready');
  const before = structuredClone(handoff.browser);
  recordProjectAction(handoff, 'browser_fill', {}, { error: 'Blocked', code: 'ACCESS_BLOCKED', url }, 'failed', 3);
  expect(handoff.browser).toEqual(before);
  recordProjectAction(handoff, 'browser_fill', {}, { url, submitted: true, responseSelector: '#reply', replyBefore: 'old' }, 'submit', 4);
  expect(handoff.browser).toMatchObject({ submitted: true, responseSelector: '#reply', replyBefore: 'old', readyAtInteraction: true });
  expect(handoff.browser!.replyAfter).toBeUndefined();
  recordProjectAction(handoff, 'browser_read', {}, { url, errors: [], selected: { selector: '#reply', text: 'new' } }, 'reply', 5);
  expect(handoff.browser).toMatchObject({ observed: true, observationId: 'reply', replyAfter: 'new', errors: [] });
});
