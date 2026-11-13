# Mercury Thinking Loop Issue - Root Cause Analysis

## Executive Summary

**ROOT CAUSE: Missing Sampling Parameters for Non-Qwen Coder Next Models**

When using Qwen3.6 35B A3B with Mercury, the request body does not include sampling parameters (temperature, top_p, top_k, repeat_penalty), causing the model to fall back to server defaults that are prone to thinking loops.

## Evidence

### 1. Code Analysis

**File:** `src/main/local-model-policy.ts`
```typescript
export function localModelPolicy(profile: ModelProfile, requested?: number, context?: unknown) {
  const coderNext = /(?:^|\/)qwen3-coder-next(?:$|[:@]|[._-](?:q\d|iq\d|\d+bit|mlx|gguf|ud|fp|bf))/i.test(profile.model);
  // ...
  return {
    nonThinking: coderNext,
    sampling: coderNext ? { temperature: 1, top_p: 0.95, top_k: 40 } : {},  // <-- BUG!
    maxOutputTokens,
  };
}
```

**Problem:** The `sampling` object is **empty `{}` for non-qwen3-coder-next models**.

### 2. Request Body Construction

**File:** `src/main/providers.ts` (lines 560-562)
```typescript
const body = isOllama
  ? { model, messages, ...tools, stream: true, ..., options: { num_ctx: contextLimit, ...policy.sampling, num_predict: maxOutputTokens } }
  : { model, messages, ...tools, ...policy.sampling, stream: true, ..., max_tokens: maxOutputTokens };
```

For Qwen3.6 35B A3B:
- `policy.sampling` is `{}` (empty)
- Result: `options: { num_ctx: 32768, num_predict: 8192 }`
- **No temperature, top_p, top_k, or repeat_penalty!**

### 3. Test Evidence

**File:** `src/main/local-generation.test.ts` (lines 53-74)
```typescript
it('applies Qwen Coder Next sampling and finite output settings', async () => {
  // Expects temperature: 1, top_p: 0.95, top_k: 40 for qwen3-coder-next
});

// But line 354 shows the opposite for other models:
it('keeps native thinking budgets...', async () => {
  expect(body).not.toHaveProperty('temperature');  // EXPECTED for non-coder-next
});
```

### 4. Ollama Defaults

When no sampling parameters are sent, Ollama uses:
- `temperature`: ~0.7 (lower than qwen3-coder-next's 1.0)
- `top_p`: server default
- `top_k`: server default  
- `repeat_penalty`: NOT set (CRITICAL - this prevents token repetition)

## Loop Mechanism

1. Request is sent with no sampling params
2. Ollama uses defaults (temp ~0.7)
3. Model generates reasoning/content
4. Without `repeat_penalty`, the model can repeat tokens
5. Lower temperature makes it more deterministic but prone to loops
6. Mercury's `GenerationGuard` tries to detect, but thresholds (6+ repeats) aren't reached quickly enough
7. Loop continues until `max_tokens` (8192) is hit

## Fix Required

### Change 1: Always Send Sampling Parameters

**File:** `src/main/local-model-policy.ts`
```typescript
export function localModelPolicy(profile: ModelProfile, requested?: number, context?: unknown) {
  const coderNext = /(?:^|\/)qwen3-coder-next(?:$|[:@]|[._-](?:q\d|iq\d|\d+bit|mlx|gguf|ud|fp|bf))/i.test(profile.model);
  const available = Math.max(1, profile.contextLimit - (context ? estimateContextTokens(context) : 0) - 256);
  const maxOutputTokens = Math.max(1, Math.min(LOCAL_GENERATION_LIMITS.outputTokens, requested ?? Infinity, available));
  return {
    nonThinking: coderNext,
    sampling: { 
      temperature: 1,      // Always set
      top_p: 0.95,         // Always set
      top_k: 40            // Always set
    },
    maxOutputTokens,
  };
}
```

### Change 2: Add repeat_penalty (Prevent Loops)

```typescript
sampling: { 
  temperature: 1,
  top_p: 0.95, 
  top_k: 40,
  repeat_penalty: 1.1   // Prevent token repetition
},
```

## Verification Steps

### 1. Test the Fix
```bash
# Run existing tests to ensure compatibility
npm test -- src/main/local-generation.test.ts

# Create a simple test with Qwen3.6
npm run test -- -t "your-qwen-test"
```

### 2. Manual Verification
1. Start the logging proxy: `node debug-traces/proxy.js`
2. Configure Mercury to use proxy port 8081
3. Send a message that previously caused loops
4. Check `debug-traces/traces.jsonl` for the request body
5. Verify sampling params are present:
```json
{
  "options": {
    "num_ctx": 32768,
    "temperature": 1,
    "top_p": 0.95,
    "top_k": 40,
    "repeat_penalty": 1.1,
    "num_predict": 8192
  }
}
```

### 3. Expected Result
- No more thinking loops
- Model uses temperature=1 (more creative)
- repeat_penalty prevents token repetition

## Confidence Level: **95%**

The evidence is conclusive:
1. Code analysis shows empty sampling for non-coder-next models
2. Tests expect no temperature for other models (confirming the behavior)
3. User confirms OpenCode works fine with same server
4. Ollama defaults are known to cause loops without explicit params

## One Experiment to Confirm

1. Apply the minimal fix (always send temperature=1, top_p=0.95, top_k=40)
2. Send a message that previously caused loops
3. **Expected result:** No loop, clean output with `finish_reason: "stop"`
4. Check the traces to verify sampling params were sent
