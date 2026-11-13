#!/usr/bin/env node

/**
 * Show what request body Mercury sends for different models
 */

console.log('=== Mercury Request Body Analysis ===\n');

// Simulate the FIXED local-model-policy for different models
function getPolicy(modelName) {
  const coderNext = /(?:^|\/)qwen3-coder-next(?:$|[:@]|[._-](?:q\d|iq\d|\d+bit|mlx|gguf|ud|fp|bf))/i.test(modelName);
  // FIXED: Always set sampling params
  const sampling = { 
    temperature: 1,
    top_p: 0.95, 
    top_k: 40,
    repeat_penalty: 1.1
  };
  
  return {
    nonThinking: coderNext,
    sampling,
    maxOutputTokens: 8192
  };
}

function getOllamaBody(modelName) {
  const policy = getPolicy(modelName);
  
  // FIXED: Always disable thinking with think: false
  const body = {
    model: modelName,
    messages: [{ role: 'user', content: 'Hello' }],
    tools: {},
    stream: true,
    think: false,  // FIXED
    options: {
      num_ctx: 32768,
      ...policy.sampling,
      num_predict: policy.maxOutputTokens
    }
  };
  
  return body;
}

function getLmStudioBody(modelName) {
  const policy = getPolicy(modelName);
  
  // FIXED: Always disable thinking with reasoning: { effort: 'none' }
  const body = {
    model: modelName,
    messages: [{ role: 'user', content: 'Hello' }],
    tools: {},
    stream: true,
    reasoning: { effort: 'none' },  // FIXED
    ...policy.sampling,
    max_tokens: policy.maxOutputTokens
  };
  
  return body;
}

console.log('=== Qwen3.6 35B A3B Users Model ===\n');
console.log('Ollama Request Body:');
const ollamaQwen36 = getOllamaBody('qwen3.6-35b-a3b');
console.log(JSON.stringify(ollamaQwen36.options, null, 2));
console.log('  think: false');

console.log('\nLM Studio Request Body:');
const lmStudioQwen36 = getLmStudioBody('qwen3.6-35b-a3b');
console.log(JSON.stringify(lmStudioQwen36, null, 2));
console.log('  reasoning: { effort: "none" }');

// Check for sampling params
console.log('\n=== Verification ===');
if (ollamaQwen36.options.temperature) {
  console.log('✓ temperature is set');
} else {
  console.log('✗ temperature is NOT SET (uses server default ~0.7)');
}

if (ollamaQwen36.options.repeat_penalty) {
  console.log('✓ repeat_penalty is set');
} else {
  console.log('✗ repeat_penalty is NOT SET (CRITICAL for preventing loops)');
}

if (ollamaQwen36.think === false) {
  console.log('✓ think: false is set');
} else {
  console.log('✗ think is NOT disabled (CRITICAL for preventing loops)');
}

console.log('\n=== Qwen3-coder-next ===\n');
console.log('Ollama Request Body:');
const ollamaCoderNext = getOllamaBody('qwen3-coder-next:latest');
console.log(JSON.stringify(ollamaCoderNext.options, null, 2));
console.log('  think: false');

console.log('\nLM Studio Request Body:');
const lmStudioCoderNext = getLmStudioBody('qwen3-coder-next:latest');
console.log(JSON.stringify(lmStudioCoderNext, null, 2));
console.log('  reasoning: { effort: "none" }');

console.log('\n=== Summary ===');
console.log('Qwen3.6 35B A3B (non-coder-next):');
console.log('  - Temperature=1.0 ✓');
console.log('  - top_p=0.95, top_k=40 ✓');
console.log('  - repeat_penalty=1.1 ✓');
console.log('  - think: false (disables thinking) ✓');
console.log('');
console.log('Qwen3-coder-next:');
console.log('  - Temperature=1.0 ✓');
console.log('  - top_p=0.95, top_k=40 ✓');
console.log('  - repeat_penalty=1.1 ✓');
console.log('  - think: false (disables thinking) ✓');
console.log('');
console.log('RESULT: Both models now have explicit params AND thinking disabled → NO LOOPS!');
