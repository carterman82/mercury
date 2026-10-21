import { expect, it } from 'vitest';
import { AnswerCompletion, isIntentOnly } from './answer-completion';

it.each([
  'Let me pull the latest hip hop news for you.',
  'Let me find the correct Windows CLI syntax.',
  'Sure, let me search the documentation.',
  "I'll check the official documentation.",
  'I will look up the latest news.',
  'I’m going to research that for you.',
  "I'm checking the docs now.",
  'I am retrieving the latest report.',
  'Certainly! Let me verify the command. Please wait.',
  'Searching the documentation now...',
  'Please wait while I gather the sources.',
  '**Let me check the latest reports.**',
  'Let me check the latest reports:',
  'Sure!\nLet me pull the latest hip hop news for you.',
  'Let me search the docs.\n\nI will check the latest release.',
])('detects whole progress-only replies: %s', text => expect(isIntentOnly(text, 'Find current information')).toBe(true));

it.each([
  'Thanks!', 'Glad it helped!', 'Sure.', '42', 'Which version of Windows are you using?',
  'I cannot verify current news because the search provider is unavailable.',
  'I cannot help with that request.',
  'Let me explain: use PowerShell to list files.',
  'Let me pull the latest news for you. The source reports a new album released today.',
  "I'll use PowerShell. Run Get-Help to view command documentation.",
  "I'll use PowerShell because its command is Get-Help.",
  'Use `Get-Command` to list available commands.',
  '```powershell\nGet-Command\n```',
  '> Let me check the documentation.',
  '"Let me check the documentation."',
  "I'll be available tomorrow.",
  'Let me know if you need more help.',
])('does not retry legitimate answers: %s', text => expect(isIntentOnly(text, 'Help with Windows commands')).toBe(false));

it.each(['Say exactly "Let me check the docs."', 'Translate this sentence into English.', 'Please repeat the following.', 'Can you rewrite this line?', 'Reply with only this phrase.', 'Write a sentence in the future tense.'])('honors literal writing requests: %s', request => {
  expect(isIntentOnly('Let me check the docs.', request)).toBe(false);
});

it('does not let an incidental mention of what sources say disable recovery', () => {
  expect(isIntentOnly('Let me pull the latest news.', 'What do the latest reports say about hip hop?')).toBe(true);
});

it('does not mistake command-line tasks for literal writing requests', () => {
  expect(isIntentOnly('Let me find the correct Windows CLI syntax.', 'Write the command line to list all files')).toBe(true);
});

it.each([
  ['Which tool will you use to list files?', "I'll use PowerShell."],
  ['How will you check it?', "I'll run the existing tests."],
  ['What would you do next?', 'I will inspect the logs.'],
])('accepts complete answers to explicit plan/method questions: %s', (request, answer) => {
  expect(isIntentOnly(answer, request)).toBe(false);
  expect(isIntentOnly('Let me find the correct syntax.', request)).toBe(true);
});

it.each(['How do you list all files in Windows?', 'How do you install Node.js on Windows?', 'What command do you use to list files?', 'Which terminal command do you use to list files?', 'How will you find the docs?'])('continues pending lookups for command and how-to questions: %s', request => {
  expect(isIntentOnly("I'll check the official documentation.", request)).toBe(true);
  expect(isIntentOnly("I'll find the correct Windows CLI syntax.", request)).toBe(true);
});

it('retains prior tool results and bounds all repairs for a response', () => {
  const messages = [{ role: 'system', content: 'Original instructions' }, { role: 'user', content: 'Find news' }, { role: 'tool', content: 'Successful saved source' }];
  const guard = new AnswerCompletion('Find news');
  expect(guard.continue(messages, 'Let me search.')).toBe(true);
  expect(guard.continue(messages, 'Here are the verified findings.')).toBe(false);
  expect(guard.continue(messages, '')).toBe(true);
  expect(() => guard.continue(messages, 'Let me search again.')).toThrow('two continuation attempts');
  expect(messages[0].content.match(/COMPLETION RECOVERY:/g)).toHaveLength(1);
  expect(messages[2].content).toBe('Successful saved source');
  expect(messages.some(message => message.role === 'assistant' && message.content === 'Let me search.')).toBe(true);
  expect(messages.at(-1)?.role).toBe('user');
});

it('allows an empty terminal reply after a real artifact but still rejects an announcement', () => {
  const guard = new AnswerCompletion('Create a document');
  const messages = [{ role: 'system', content: 'Instructions' }];
  expect(guard.continue(messages, '', true)).toBe(false);
  expect(guard.continue(messages, 'Let me create the document.', true)).toBe(true);
});
