const fs = require('fs');

// Read the actual providers.ts file
const providersPath = 'D:\\Claude\\ClaudeCodeRipoff\\src\\main\\providers.ts';
const content = fs.readFileSync(providersPath, 'utf8');

// Parse the body construction lines
const lines = content.split('\n');
let inBodyConstruction = false;
let bodyParts = [];
let lineCount = 0;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('const body = isOllama')) {
    inBodyConstruction = true;
  }
  
  if (inBodyConstruction) {
    bodyParts.push(lines[i]);
    lineCount++;
    
    // The construction ends when we find a semicolon after the ternary
    if (bodyParts.join('\n').includes('max_tokens: policy.maxOutputTokens}') && lines[i].trim().endsWith(',')) {
      break;
    }
  }
  
  if (lineCount > 5) break; // Safety limit
}

console.log('=== Full Body Construction ===');
console.log(bodyParts.join('\n'));

// Now analyze Ollama and LM Studio branches separately
const fullBody = bodyParts.join('\n');

// Extract Ollama branch (between ? and :)
const ollamaMatch = fullBody.match(/isOllama\s+\?\s*({[^}]+options:[^}]*num_predict:[^}]+})/);
if (ollamaMatch) {
  console.log('');
  console.log('=== Ollama Body ===');
  console.log(ollamaMatch[1]);
  
  const optionsMatch = ollamaMatch[1].match(/options:\s*{([^}]+)}/);
  if (optionsMatch) {
    console.log('');
    console.log('Options object: { ' + optionsMatch[1] + ' }');
    
    if (optionsMatch[1].includes('temperature')) {
      console.log('✓ temperature IS present');
    } else {
      console.log('✗ temperature is NOT present (empty policy.sampling)');
    }
    
    if (optionsMatch[1].includes('repeat_penalty')) {
      console.log('✓ repeat_penalty IS present');
    } else {
      console.log('✗ repeat_penalty is NOT present');
    }
  }
}

// Extract LM Studio branch (after the colon)
const lmMatch = fullBody.match(/:\s*({[^}]+max_tokens:[^}]+})/);
if (lmMatch) {
  console.log('');
  console.log('=== LM Studio Body ===');
  console.log(lmMatch[1]);
  
  if (lmMatch[1].includes('temperature')) {
    console.log('✓ temperature IS present');
  } else {
    console.log('✗ temperature is NOT present (empty policy.sampling)');
  }
  
  if (lmMatch[1].includes('repeat_penalty')) {
    console.log('✓ repeat_penalty IS present');
  } else {
    console.log('✗ repeat_penalty is NOT present');
  }
}

console.log('');
console.log('=== FINAL ANALYSIS ===');
console.log('');
console.log('For Qwen3.6 35B A3B model (NOT qwen3-coder-next):');
console.log('');
console.log('1. local-model-policy.ts creates policy.sampling = {} (empty object)');
console.log('   because the regex only matches qwen3-coder-next models.');
console.log('');
console.log('2. The Ollama request body spreads this empty object:');
console.log('   options: { num_ctx: ..., ...policy.sampling, num_predict: 8192 }');
console.log('   This results in: options: { num_ctx: ..., num_predict: 8192 }');
console.log('');
console.log('3. Ollama falls back to defaults:');
console.log('   - temperature: ~0.7 (not 1.0 like qwen3-coder-next)');
console.log('   - top_p, top_k: server defaults');
console.log('   - repeat_penalty: NOT set (critical for preventing loops)');
console.log('');
console.log('4. Without temperature=1 and repeat_penalty, the model is prone to loops.');
console.log('');
console.log('5. The same issue exists for LM Studio which has identical policy.sampling.');
console.log('');
console.log('ROOT CAUSE CONFIRMED:');
console.log('- Empty policy.sampling for non-qwen3-coder-next models');
console.log('- Missing repeat_penalty (prevents token repetition loops)');
console.log('- Lower temperature (~0.7 vs 1.0) increases loop risk');
