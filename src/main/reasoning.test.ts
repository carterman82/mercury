import { expect, it } from 'vitest';
import { ReasoningStream } from './reasoning';

it('separates a leading think block even when markers arrive a character at a time', () => {
  let answer = '', reasoning = '';
  const stream = new ReasoningStream(part => { answer += part; }, part => { reasoning += part; });
  for (const part of ' \n<think>Consider the question.</think>\n**Answer**') stream.push(part);
  stream.finish();
  expect(reasoning).toBe('Consider the question.');
  expect(answer).toBe('\n**Answer**');
});

it('preserves think tags inside an ordinary answer or code example', () => {
  let answer = '', reasoning = '';
  const stream = new ReasoningStream(part => { answer += part; }, part => { reasoning += part; });
  stream.push('Use `<think>` in this example.'); stream.finish();
  expect(answer).toBe('Use `<think>` in this example.');
  expect(reasoning).toBe('');
});
