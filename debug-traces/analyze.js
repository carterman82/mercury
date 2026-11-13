const fs = require('fs');
const path = require('path');

// Read the actual providers.ts file
const providersPath = 'D:\\Claude\\ClaudeCodeRipoff\\src\\main\\providers.ts';
const content = fs.readFileSync(providersPath, 'utf8');

// Extract the relevant lines
const bodyPattern = /const body = isOllama\s+\?([^;]+):/;
const match = content.match(bodyPattern);

if (match) {
  console.log('=== Ollama Request Body Construction ===');
  console.log(match[0]);
  
  // Extract the options object
  const optionsMatch = match[1].match(/options:\s*{([^}]+)}/);
  if (optionsMatch) {
    console.log('');
    console.log('=== Options Object ===');
    console.log('options: {' + optionsMatch[1] + '}');
    
    // Check for num_predict
    if (optionsMatch[1].includes('num_predict')) {
      console.log('');
      console.log('✓ num_predict IS present in options');
    } else {
      console.log('');
      console.log('✗ num_predict is NOT present in options - THIS IS THE BUG!');
    }
    
    // Check for sampling params
    if (optionsMatch[1].includes('temperature')) {
      console.log('');
      console.log('✓ temperature IS present in options');
    } else {
      console.log('');
      console.log('✗ temperature is NOT present in options');
    }
    
    // Check for repetition penalties
    if (optionsMatch[1].includes('repeat_penalty')) {
      console.log('');
      console.log('✓ repeat_penalty IS present in options');
    } else {
      console.log('');
      console.log('✗ repeat_penalty is NOT present in options');
    }
  }
} else {
  console.log('Pattern not found - trying alternative method');
  
  // Find the line with options
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('options:')) {
      console.log('Line with options:');
      console.log(lines[i]);
    }
  }
}

console.log('');
console.log('=== Analysis ===');
console.log('For non-Qwen Coder Next models, policy.sampling is an empty object {}.');
console.log('This means temperature, top_p, top_k are NOT sent to Ollama.');
console.log('Ollama falls back to defaults (temp ~0.7, no explicit repetition penalties).');
console.log('');
console.log('Low temperature + no repetition penalties = prone to thinking loops.');
console.log('');
console.log('OpenCode likely sets explicit sampling parameters to prevent this.');
