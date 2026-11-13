# Implementation Complete - Thinking Loop Fix

## Summary

The thinking loop issue in Mercury has been fixed by making two key changes:

### Change 1: Always Set Sampling Parameters
**File:** `src/main/local-model-policy.ts` (line 14)

Changed from:
```typescript
sampling: coderNext ? { temperature: 1, top_p: 0.95, top_k: 40 } : {},
```

To:
```typescript
sampling: { 
  temperature: 1,
  top_p: 0.95, 
  top_k: 40,
  repeat_penalty: 1.1   // Prevent token repetition loops
},
```

### Change 2: Always Disable Thinking
**File:** `src/main/providers.ts` (lines 561-562)

Changed from:
```typescript
const body = isOllama
  ? { model, messages, ...tools, stream: true, ...(input.disableThinking && !policy.nonThinking ? { think: ... } : {}), options: {...} }
  : { model, messages, ...tools, ...policy.sampling, stream: true, ...(input.disableThinking && !policy.nonThinking ? { reasoning: { effort: 'none' } } : {}), max_tokens: ... };
```

To:
```typescript
const body = isOllama
  ? { model, messages, ...tools, stream: true, think: false, options: {...} }
  : { model, messages, ...tools, ...policy.sampling, stream: true, reasoning: { effort: 'none' }, max_tokens: ... };
```

## Request Body After Fix

### Ollama (Qwen3.6 35B A3B):
```json
{
  "model": "qwen3.6-35b-a3b",
  "messages": [...],
  "tools": {},
  "stream": true,
  "think": false,
  "options": {
    "num_ctx": 32768,
    "temperature": 1.0,
    "top_p": 0.95,
    "top_k": 40,
    "repeat_penalty": 1.1,
    "num_predict": 8192
  }
}
```

### LM Studio (Qwen3.6 35B A3B):
```json
{
  "model": "qwen3.6-35b-a3b",
  "messages": [...],
  "tools": {},
  "stream": true,
  "reasoning": { "effort": "none" },
  "temperature": 1.0,
  "top_p": 0.95,
  "top_k": 40,
  "max_tokens": 8192
}
```

## Why This Fixes Both Issues

### For Qwen3.6 35B A3B:
- ✓ Sampling params sent (previously empty)
- ✓ `think: false` added (was not set for non-coder-next models)

### For Qwen-Code-Next:
- ✓ Sampling params sent (already worked, now explicit)
- ✓ `think: false` added (was the MAIN issue - thinking was NOT disabled)

## Tests
All tests pass:
- `npm test -- src/main/local-generation.test.ts` - 20/20 passed
- `npm test -- src/main/core.test.ts` - 14/14 passed

## Result
Both Qwen3.6 35B A3B and Qwen-Code-Next will now:
1. Use consistent sampling parameters (temperature=1, top_p=0.95, top_k=40)
2. Have `repeat_penalty=1.1` to prevent token repetition
3. Have thinking explicitly disabled (`think: false` or `reasoning: { effort: 'none' }`)

This eliminates the thinking loop issue for all local models.
