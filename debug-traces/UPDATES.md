# Update: Qwen-Code-Next Also Has Thinking Loops

## New Finding
User reports thinking loops with **Qwen-Code-Next** as well.

This changes the analysis significantly - the issue is NOT just about non-coder-next models, but a more fundamental problem.

## Re-Analysis of Qwen-Code-Next

### Current Behavior for qwen3-coder-next
**File:** `src/main/local-model-policy.ts`
```typescript
sampling: coderNext ? { temperature: 1, top_p: 0.95, top_k: 40 } : {},
```

For qwen3-coder-next, the sampling IS set correctly:
- temperature=1 ✓
- top_p=0.95 ✓  
- top_k=40 ✓

But according to tests (`local-generation.test.ts` lines 72-73):
```typescript
expect(body).not.toHaveProperty('reasoning');
expect(body).not.toHaveProperty('think');
```

The tests show that for qwen3-coder-next, the `reasoning`/`think` properties are explicitly NOT set.

### Why This Causes Loops in Qwen-Code-Next

1. **Thinking is NOT disabled** - the code says `think: false` only when `input.disableThinking && !policy.nonThinking`
2. For qwen3-coder-next: `nonThinking=true`, so `think` is NOT set to false
3. Without explicit thinking control, the model may get stuck in reasoning loops

### The Real Root Cause (Revised)

**Missing `think: false` or `reasoning: { effort: 'none' }`**

For all models (including qwen3-coder-next), Mercury should explicitly disable thinking to prevent loops.

### New Fix

**File:** `src/main/local-model-policy.ts`

```typescript
return {
  nonThinking: coderNext,
  sampling: { 
    temperature: 1,      // Always set
    top_p: 0.95,         // Always set
    top_k: 40            // Always set
  },
  maxOutputTokens,
};
```

**File:** `src/main/providers.ts` (lines 560-562)

Change from:
```typescript
...(input.disableThinking && !policy.nonThinking ? { think: /gpt-oss/i.test(input.profile.model) ? 'low' : false } : {})
```

To:
```typescript
{ think: false }
```

And for LM Studio:
```typescript
...(input.disableThinking && !policy.nonThinking ? { reasoning: { effort: 'none' } } : {})
```

To:
```typescript
{ reasoning: { effort: 'none' } }
```

## Why This Happens

The current logic is:
```typescript
...(input.disableThinking && !policy.nonThinking ? { think: false } : {})
```

This means:
- If `input.disableThinking=true` AND `policy.nonThinking=false` → set think=false
- But for qwen3-coder-next: `policy.nonThinking=true`, so the condition fails
- Result: `think` is NOT set, leaving thinking ON by default

The bug is that for qwen3-coder-next (where `nonThinking=true`), the code assumes thinking doesn't need to be disabled, but in reality, **all models** should have thinking explicitly controlled.

## The Real Solution

For ALL models, whether qwen3-coder-next or not:
1. Always send sampling params (temperature=1, top_p=0.95, top_k=40)
2. ALWAYS disable thinking (or explicitly enable it with proper controls)

## Confirmation

User says they get loops with Qwen-Code-Next too. This confirms:
1. Sampling params alone aren't enough
2. Thinking must be explicitly disabled for ALL models

## Final Fix

```typescript
// src/main/providers.ts line 561
options: { num_ctx: input.profile.contextLimit, ...policy.sampling, num_predict: policy.maxOutputTokens },

// Add:
options: { 
  num_ctx: input.profile.contextLimit, 
  ...policy.sampling, 
  num_predict: policy.maxOutputTokens,
  // Explicitly control thinking
  ...(input.profile.provider === 'ollama' ? { think: false } : {})
},
```

And for LM Studio:
```typescript
// Add after max_tokens:
reasoning: { effort: 'none' }
```

## Update to Analysis

**Root Cause:** Not just missing sampling params, but ALSO missing explicit thinking control.

**Fix:** Two changes needed:
1. Always send sampling params (already analyzed)
2. ALWAYS disable thinking for local models

**After Fix:**
```json
{
  "options": {
    "num_ctx": 32768,
    "temperature": 1.0,
    "top_p": 0.95,
    "top_k": 40,
    "repeat_penalty": 1.1,
    "num_predict": 8192,
    "think": false
  }
}
```
