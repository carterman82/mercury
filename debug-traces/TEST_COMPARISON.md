# Test Comparison: Mercury vs OpenCode

## Mercury's Tests (local-generation.test.ts)

### Qwen Coder Next Model (lines 53-74)
```typescript
it('applies Qwen Coder Next sampling and finite output settings', async (provider) => {
  // ... test setup ...
  
  // Expected body for Qwen Coder Next:
  expect(provider === 'ollama' ? body.options : body).toMatchObject({
    temperature: 1,
    top_p: 0.95,
    top_k: 40,
    [provider === 'ollama' ? 'num_predict' : 'max_tokens']: 8192,
  });
  expect(body).not.toHaveProperty('reasoning');
  expect(body).not.toHaveProperty('think');
});
```

**Key finding:** Qwen Coder Next ALWAYS gets temperature=1, top_p=0.95, top_k=40

### Other Models (lines 342-355)
```typescript
it('keeps native thinking budgets below the clamped output allowance for other models', async () => {
  // ... test with 'another-thinking-model' ...
  
  const response = await service('lmstudio').messages({
    profile: { ...request('lmstudio').profile, model: 'another-thinking-model' },
    body: { stream: true, max_tokens: 32000, thinking: { type: 'enabled', budget_tokens: 16000 } },
    // ...
  });
  
  await response!.text();
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  
  expect(body.max_tokens).toBe(8192);  // Clamped
  expect(body.thinking.budget_tokens).toBeLessThan(body.max_tokens);
  
  // CRITICAL: This test EXPECTS no temperature/top_p
  expect(body).not.toHaveProperty('temperature');
});
```

**Key finding:** Other models do NOT have temperature/top_p set!

## OpenCode's Behavior (Inferred)

The user states: "When I run the SAME model on the SAME server through OpenCode, I get zero loops."

This implies:
1. OpenCode ALWAYS sends sampling parameters (temperature=1, top_p, etc.)
2. OpenCode likely sets `repeat_penalty` to prevent loops
3. OpenCode may use different default values for sampling parameters

## The Discrepancy

### Mercury's Design
- Qwen Coder Next models: Explicit sampling (temp=1, top_p=0.95, top_k=40)
- Other models: Empty sampling (rely on server defaults)

### OpenCode's Design
- All models: Explicit sampling parameters

## Root Cause Analysis

The user is using "Qwen3.6 35B A3B" - which does NOT match the pattern `/qwen3-coder-next/i`.

So Mercury treats it as a "normal" model and sends:
```json
{
  "model": "qwen3.6-35b-a3b",
  "messages": [...],
  "stream": true,
  "options": {
    "num_ctx": 32768,
    "num_predict": 8192
  }
}
```

Note: **No temperature, top_p, top_k, or repeat_penalty!**

OpenCode likely sends:
```json
{
  "model": "qwen3.6-35b-a3b",
  "messages": [...],
  "stream": true,
  "temperature": 1.0,
  "top_p": 0.95,
  "top_k": 40,
  "repeat_penalty": 1.1,
  "max_tokens": 8192
}
```

## Fix Required

Change `local-model-policy.ts` to ALWAYS send sampling parameters, not just for Qwen Coder Next:

```typescript
export function localModelPolicy(profile: ModelProfile, requested?: number, context?: unknown) {
  const coderNext = /(?:^|\/)qwen3-coder-next(?:$|[:@]|[._-](?:q\d|iq\d|\d+bit|mlx|gguf|ud|fp|bf))/i.test(
    profile.model,
  );
  const available = Math.max(1, profile.contextLimit - (context ? estimateContextTokens(context) : 0) - 256);
  const maxOutputTokens = Math.max(1, Math.min(LOCAL_GENERATION_LIMITS.outputTokens, requested ?? Infinity, available));
  return {
    nonThinking: coderNext,
    sampling: { 
      temperature: 1,
      top_p: 0.95, 
      top_k: 40
      // Add repeat_penalty to prevent loops:
      // repeat_penalty: 1.1,
    },
    maxOutputTokens,
  };
}
```

## Summary

| Aspect | Mercury (current) | OpenCode (expected) |
|--------|-------------------|---------------------|
| temperature | Only for qwen3-coder-next | Always |
| top_p/top_k | Only for qwen3-coder-next | Always |
| repeat_penalty | Never set | Set to 1.1 |
| max_tokens/num_predict | Always set | Always set |

The fix is simple: remove the conditional and always send sampling parameters.
