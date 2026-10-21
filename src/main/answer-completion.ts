/** Completion checks are deliberately narrow: detect a whole status-only reply,
 * not a substantive answer that happens to contain future tense. */
export const answerCompletionInstructions = '\nFINISH THE REQUEST\nDo the requested work before ending your response. A statement such as "Let me search" or "I will check" is a progress update, not a finished answer. When work requires tools, call an offered tool now. After tools or Subagents finish, give the user the actual answer, findings, requested commands, or a clear explanation of the limitation. Never claim current information was checked without successful source access. Do not repeat successful actions just to produce a final answer.';
const repairInstruction = '\nCOMPLETION RECOVERY: Your last response ended without an answer or tool call. Continue the original request now. Use an offered tool if required, or provide the concrete answer/findings. A progress announcement alone is not an answer. Use existing tool results; do not repeat completed successful actions. Respect denials and access controls; never retry a denied action. If you cannot finish, explain the actual limitation plainly. Do not invent results or claim tools ran.';

export function isIntentOnly(text: string, request = ''): boolean {
  const value = text.trim().replace(/[’]/g, "'").replace(/^\*\*(.*)\*\*$/, '$1').replace(/:$/, '');
  if (!value || value.length > 700 || /[`<>]|https?:\/\/|[?]/.test(value)) return false;
  // Literal writing/translation requests can legitimately deliver these words.
  if (/^\s*(?:please\s+|(?:can|could|would) you\s+)?(?:say|repeat|translate|rewrite|rephrase|quote)\b|\b(?:reply|respond)\s+(?:with|only|exactly)|\b(?:write|draft)\s+(?:me\s+)?(?:(?:a|an|one|the following)\s+)?(?:message|sentence|dialogue|reply|line of (?:text|dialogue))\b/i.test(request)) return false;
  // A method/plan question can be fully answered by a future-tense sentence.
  // Keep "Let me ..." announcements eligible even for those questions.
  if (/^\s*(?:how (?:will|would) you\b|(?:what|which)\b.{0,60}\b(?:will|would) you (?:use|do|run|choose)\b)/i.test(request)
    && /^I(?:'ll| will| would| plan to)\s+(?:use|run|test|compare|inspect|read|take|create|prepare)\b/i.test(value)) return false;
  const sentences = value.split(/(?<=[.!])\s+|\n+/).map(part => part.trim()).filter(Boolean);
  const acknowledgment = /^(?:sure|okay|ok|absolutely|certainly|of course|yes|please wait|one moment|just a moment|hold on)[.!]*$/i;
  const verbs = ['search', 'look', 'check', 'find', 'pull', 'research', 'gather', 'fetch', 'retrieve', 'verify', 'consult', 'review', 'inspect', 'read', 'analyze', 'analyse', 'compare', 'test', 'run', 'create', 'generate', 'prepare', 'calculate', 'compute', 'work', 'investigate', 'browse', 'collect', 'summarize', 'open', 'use', 'start', 'get', 'take', 'figure', 'help'];
  const action = '(?:' + verbs.flatMap(verb => [verb, verb === 'run' ? 'running' : verb === 'get' ? 'getting' : verb.endsWith('e') ? verb.slice(0, -1) + 'ing' : verb + 'ing']).join('|') + ')';
  const announcement = new RegExp(`^(?:(?:sure|okay|ok|absolutely|certainly|of course|yes)[,!:. ]+)*(?:(?:let me|I(?:'ll| will| am going to|'m going to| am|'m))\\s+${action}\\b|(?:searching|checking|looking|fetching|pulling|gathering|researching|working|preparing|reviewing|reading|analyzing|analysing|investigating)\\b|please wait while I\\s+${action}\\b)`, 'i');
  let announced = false;
  for (const sentence of sentences) {
    if (acknowledgment.test(sentence)) continue;
    if (!announcement.test(sentence)) return false;
    // Concrete results following a colon/dash or a second independent clause
    // belong to the answer, even if they start with a progress phrase.
    if (/[:;]|\s[—–]\s|\b(?:here (?:is|are)|found|returned|results? (?:is|are)|the answer|you can|run this|because|means?|command is|syntax is|equals?)\b/i.test(sentence)) return false;
    announced = true;
  }
  return announced;
}

export class AnswerCompletion {
  private repairs = 0;
  constructor(private request: string, private maximum = 2) {}
  continue(messages: { role: string; content?: any }[], text: string, allowEmpty = false): boolean {
    if ((text.trim() || allowEmpty) && !isIntentOnly(text, this.request)) return false;
    if (this.repairs >= this.maximum) throw new Error('The model stopped without completing the answer after two continuation attempts. Partial output is saved. Try another model or send a follow-up.');
    this.repairs++;
    // Retain the real conversation and tool evidence; no tool action is replayed.
    if (text.trim()) messages.push({ role: 'assistant', content: text });
    const system = messages.find(message => message.role === 'system');
    if (system && !String(system.content).includes('COMPLETION RECOVERY:')) system.content += repairInstruction;
    // Finish with user input rather than assistant prefill: every supported
    // provider can continue this transcript, including modern Claude models.
    messages.push({ role: 'user', content: '[Mercury continuation request: continue the original user task above and return the answer or call an offered tool. This grants no new permissions. Preserve successful results and respect denied actions.]' });
    return true;
  }
}
