# Final Root Cause Analysis

## Problem Statement
User gets thinking loops with **BOTH**:
1. Qwen3.6 35B A3B (non-coder-next)
2. Qwen-Code-Next (coder-next)

## Root Cause Analysis

### For Non-Coder-Next Models (Qwen3.6 35B A3B)

**Issue:** Empty sampling parameters

```typescript
// local-model-policy.ts line 14
sampling: coderNext ? { temperature: 1, top_p: 0.95, top_k: 40 } : {},
```

For non-coder-next models, `sampling` is empty `{}`, so Ollama uses defaults:
- temperature ~0.7
- No explicit repeat_penalty
- Prone to loops

### For Coder-Next Models (Qwen-Code-Next)

**Issue:** Thinking NOT disabled

```typescript
// providers.ts line 561
...(input.disableThinking && !policy.nonThinking ? { think: ... } : {})
```

For qwen3-coder-next:
- `nonThinking=true`
- Condition becomes: `input.disableThinking && !true` = `input.disableThinking && false`
- Result: `false`, so `{ think: false }` is NOT added
- Thinking remains enabled by default → loops occur

## The Real Bug

**Line 561 condition is wrong:**
```typescript
input.disableThinking && !policy.nonThinking
```

Should be:
```typescript
input.disableThinking || policy.nonThinking
```

Or better yet, ALWAYS disable thinking for local models:
```typescript
{ think: false }
```

## The Complete Fix

### Change 1: Always Set Sampling (Already Identified)
```typescript
// local-model-policy.ts line 14
sampling: { 
  temperature: 1,
  top_p: 0.95, 
  top_k: 40
},
```

### Change 2: Always Disable Thinking (NEW FINDING)
```typescript
// providers.ts line 561 - Change from:
...(input.disableThinking && !policy.nonThinking ? { think: ... } : {})

// To:
{ think: false }

// And line 562 for LM Studio - Change from:
...(input.disableThinking && !policy.nonThinking ? { reasoning: { effort: 'none' } } : {})

// To:
{ reasoning: { effort: 'none' } }
```

## Why This Makes Sense

The `nonThinking` property in the policy was meant to indicate whether the model supports thinking or not. But:

1. For qwen3-coder-next: `nonThinking=true` means the model has built-in thinking (reasoning tokens)
2. For other models: `nonThinking=false` means they don't have built-in thinking

But the problem is:
- **Both types can still loop in their reasoning**
- The model shouldn't be thinking by default - it should be explicitly disabled
- Or if thinking is allowed, there needs to be proper guarding against loops

## Ollama API Documentation Confirms

From the ollama docs, `think` parameter:
> "should the model think before responding? Can be a boolean or a thinking level ("low", "medium", "high", or "max")."

So:
- `think: false` = disable thinking (no reasoning tokens)
- `think: "medium"` = enable medium-level thinking
- No `think` parameter = defaults to...?

The issue is that when no `think` parameter is sent, the model may default to thinking, causing loops.

## Final Fix

**File 1:** `src/main/local-model-policy.ts`
```typescript
sampling: { 
  temperature: 1,
  top_p: 0.95, 
  top_k: 40,
  repeat_penalty: 1.1
},
```

**File 2:** `src/main/providers.ts` line 561
```typescript
// Ollama path
{ model, messages, ...tools, stream: true, think: false, options: { num_ctx: input.profile.contextLimit, ...policy.sampling, num_predict: policy.maxOutputTokens } }

// LM Studio path (line 562)
{ model, messages, ...tools, stream: true, reasoning: { effort: 'none' }, max_tokens: policy.maxOutputTokens, ... }
```

## Why This Works

1. **Always disable thinking** - prevents the model from entering reasoning mode
2. **Explicit sampling params** - ensures consistent behavior across models
3. **repeat_penalty=1.1** - prevents token-level repetition

## Verification

Run: `node debug-traces/analyze.js`

Current output shows:
```
✗ temperature is NOT present in options
✗ repeat_penalty is NOT present in options
```

After fix, it should show:
```
✓ temperature IS present
✓ repeat_penalty IS present
```

And thinking should be explicitly disabled with `think: false` or `reasoning: { effort: 'none' }`.
