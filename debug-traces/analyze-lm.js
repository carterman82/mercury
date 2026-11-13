const fs = require('fs');

// Read the actual providers.ts file
const providersPath = 'D:\\Claude\\ClaudeCodeRipoff\\src\\main\\providers.ts';
const content = fs.readFileSync(providersPath, 'utf8');

// Find the LM Studio body construction
const lines = content.split('\n');
let foundLMStudio = false;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('const body = isOllama')) {
    // Find the LM Studio branch (after the colon)
    for (let j = i; j < lines.length && j < i + 3; j++) {
      if (lines[j].includes(':')) {
        const colonLine = lines[j];
        console.log('=== LM Studio Request Body ===');
        
        // Extract the part after the colon
        const parts = colonLine.split(':');
        if (parts.length >= 2) {
          // Get the next line too if this is incomplete
          let lmBody = parts.slice(1).join(':').trim();
          
          // Check if it has sampling params
          console.log(lmBody);
          
          console.log('');
          console.log('=== Analysis ===');
          
          if (lmBody.includes('...policy.sampling')) {
            console.log('✓ Uses spread operator for policy.sampling');
            
            if (lmBody.includes('temperature')) {
              console.log('✓ temperature IS explicitly set');
            } else {
              console.log('✗ temperature is NOT explicitly set (relies on spread of policy.sampling)');
            }
            
            if (lmBody.includes('max_tokens')) {
              console.log('✓ max_tokens IS present');
            } else {
              console.log('✗ max_tokens is NOT present - BUG!');
            }
            
            if (lmBody.includes('repeat_penalty')) {
              console.log('✓ repeat_penalty IS present');
            } else {
              console.log('✗ repeat_penalty is NOT present');
            }
          }
        }
        
        foundLMStudio = true;
        break;
      }
    }
  }
}

if (!foundLMStudio) {
  console.log('Could not find LM Studio body construction');
}

console.log('');
console.log('=== Root Cause Summary ===');
console.log('');
console.log('Ollama (Qwen3.6 35B A3B):');
console.log('- Has num_predict: YES (8192 tokens)');
console.log('- Has temperature: NO (empty policy.sampling for non-coder-next models)');
console.log('- Has top_p/top_k: NO');
console.log('');
console.log('LM Studio:');
console.log('- Uses same policy.sampling as Ollama');
console.log('');
console.log('Issue: When policy.sampling is {}, sampling falls to Ollama defaults.');
console.log('- Temperature ~0.7 (lower than Qwen Coder Nexts 1.0)');
console.log('- No explicit repetition penalties');
console.log('');
console.log('This causes the model to be more deterministic but prone to loops.');
console.log('');
console.log('OpenCode likely always sets temperature=1, top_p=0.95, etc.');
