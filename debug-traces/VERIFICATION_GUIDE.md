# Verification Guide for Mercury Thinking Loop Issue

## Quick Start (5 minutes)

### Step 1: Confirm the Issue Exists
```bash
cd D:\Claude\ClaudeCodeRipoff\debug-traces
node show-requests.js
```

**Expected Output:**
- Ollama body for Qwen3.6 35B A3B shows NO temperature, repeat_penalty
- Ollama body for qwen3-coder-next shows temperature=1

### Step 2: View the Analysis
Read `USER_SUMMARY.md` or `FINAL_SUMMARY.md`

### Step 3: Apply the Fix

**File:** `D:\Claude\ClaudeCodeRipoff\src\main\local-model-policy.ts`

**Change line 14 from:**
```typescript
sampling: coderNext ? { temperature: 1, top_p: 0.95, top_k: 40 } : {},
```

**To:**
```typescript
sampling: { 
  temperature: 1,
  top_p: 0.95, 
  top_k: 40,
  repeat_penalty: 1.1
},
```

### Step 4: Run Tests
```bash
cd D:\Claude\ClaudeCodeRipoff
npm test -- src/main/local-generation.test.ts
```

**Expected:** Tests pass (may need minor updates to expect sampling params)

### Step 5: Manual Test
1. Start your llama.cpp server (e.g., port 8080)
2. Configure Mercury with Qwen3.6 35B A3B
3. Send a multi-step message that caused loops before
4. **Expected:** No loop, clean finish with `finish_reason: "stop"`

## Detailed Evidence

### 1. Request Body Comparison

**Before Fix (Qwen3.6 35B A3B):**
```json
{
  "model": "qwen3.6-35b-a3b",
  "options": {
    "num_ctx": 32768,
    "num_predict": 8192
  }
}
```

**After Fix (Qwen3.6 35B A3B):**
```json
{
  "model": "qwen3.6-35b-a3b",
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

### 2. Why This Fixes the Loop

| Parameter | Before Fix | After Fix | Effect |
|-----------|------------|-----------|--------|
| temperature | ~0.7 (default) | 1.0 | More creative, less deterministic |
| top_p | server default | 0.95 | Better sampling control |
| top_k | server default | 40 | Better sampling control |
| repeat_penalty | NOT SET | 1.1 | PREVENTS TOKEN REPETITION |

### 3. Test Results

```bash
npm test -- src/main/local-generation.test.ts
```

**Current:** 20 tests pass (some may expect no temperature for non-coder-next models)

**After fix:** May need to update tests to expect sampling params always.

## Common Questions

### Q: Why doesn't OpenCode have this issue?
**A:** OpenCode always sends sampling parameters. The user confirmed "OpenCode works fine with same model/server."

### Q: Why does qwen3-coder-next work fine?
**A:** It has `nonThinking: true` and gets explicit sampling parameters. Other models don't.

### Q: What about LM Studio?
**A:** Same issue - empty sampling parameters for non-coder-next models.

### Q: Is this a bug or intentional?
**A:** Looks like an oversight. The code is explicitly written to only set sampling for qwen3-coder-next models.

## Files Changed

### Production Code (1 file)
- `src/main/local-model-policy.ts` - Line 14: Remove conditional from sampling

### Test Files (may need update)
- `src/main/local-generation.test.ts` - Some tests may need updates

### Debugging Files (in debug-traces/)
- `show-requests.js` - Shows request bodies
- `analyze.js` - Analyzes code
- `verify-issue.js` - Verifies issue
- `proxy.js` - Logging proxy (optional)

## One-Liner Fix

```diff
-export function localModelPolicy(profile: ModelProfile, requested?: number, context?: unknown) {
-  const coderNext = /(?:^|\/)qwen3-coder-next(?:$|[:@]|[._-](?:q\d|iq\d|\d+bit|mlx|gguf|ud|fp|bf))/i.test(profile.model);
-  const available = Math.max(1, profile.contextLimit - (context ? estimateContextTokens(context) : 0) - 256);
-  const maxOutputTokens = Math.max(1, Math.min(LOCAL_GENERATION_LIMITS.outputTokens, requested ?? Infinity, available));
-  return {
-    nonThinking: coderNext,
-    sampling: coderNext ? { temperature: 1, top_p: 0.95, top_k: 40 } : {},
-    maxOutputTokens,
-  };
+export function localModelPolicy(profile: ModelProfile, requested?: number, context?: unknown) {
+  const coderNext = /(?:^|\/)qwen3-coder-next(?:$|[:@]|[._-](?:q\d|iq\d|\d+bit|mlx|gguf|ud|fp|bf))/i.test(profile.model);
+  const available = Math.max(1, profile.contextLimit - (context ? estimateContextTokens(context) : 0) - 256);
+  const maxOutputTokens = Math.max(1, Math.min(LOCAL_GENERATION_LIMITS.outputTokens, requested ?? Infinity, available));
+  return {
+    nonThinking: coderNext,
+    sampling: { temperature: 1, top_p: 0.95, top_k: 40, repeat_penalty: 1.1 },
+    maxOutputTokens,
+  };
 }
```

That's it! Apply this diff and test.
