// Script to detect the issue with Mercury's Ollama request construction

const fs = require('fs');
const path = require('path');

// Read the actual providers.ts file
const providersPath = path.join(__dirname, '..', 'src', 'main', 'providers.ts');
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
    console.log('\n=== Options Object ===');
    console.log('options: { ' + optionsMatch[1] + ' }');
    
    // Check for num_predict
    if (optionsMatch[1].includes('num_predict')) {
      console.log('\n✓ num_predict IS present in options');
    } else {
      console.log('\n✗ num_predict is NOT present in options - THIS IS THE BUG!');
    }
    
    // Check for sampling params
    if (optionsMatch[1].includes('temperature')) {
      console.log('✓ temperature IS present in options');
    } else {
      console.log('✗ temperature is NOT present in options');
    }
    
    // Check for repetition penalties
    if (optionsMatch[1].includes('repeat_penalty')) {
      console.log('✓ repeat_penalty IS present in options');
    } else {
      console.log('✗ repeat_penalty is NOT present in options');
    }
  }
} else {
  console.log('Could not find body construction pattern');
}

console.log('\n=== Analysis ===');
console.log('For non-Qwen Coder Next models, policy.sampling is an empty object {}.');
console.log('This means temperature, top_p, top_k are NOT sent to Ollama.');
console.log('Ollama falls back to defaults (temp ~0.7, no explicit repetition penalties).');
console.log('');
console.log('Low temperature + no repetition penalties = prone to thinking loops.');
console.log('');
console.log('OpenCode likely sets explicit sampling parameters to prevent this.');
