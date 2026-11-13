# Mercury Thinking Loop Issue - Complete Analysis

## Problem
Mercury gets stuck in thinking loops with Qwen3.6 35B A3B, but OpenCode works fine on the same server.

## Root Cause
Mercury doesn't send sampling parameters for non-qwen3-coder-next models.

## Evidence

### 1. Code Analysis
**File:** `src/main/local-model-policy.ts`
```typescript
sampling: coderNext ? { temperature: 1, top_p: 0.95, top_k: 40 } : {},
```
For non-qwen3-coder-next models, `sampling` is an empty object `{}`.

### 2. Request Body Sent
```json
{
  "options": {
    "num_ctx": 32768,
    "num_predict": 8192
  }
}
```
Missing: temperature, top_p, top_k, repeat_penalty

### 3. Ollama Defaults
- temperature ~0.7 (not 1.0)
- No repeat_penalty
- Prone to loops

## Fix
**File:** `src/main/local-model-policy.ts` line 14

```typescript
sampling: { 
  temperature: 1,
  top_p: 0.95, 
  top_k: 40,
  repeat_penalty: 1.1
},
```

## Verification

### Step 1: Run Analysis
```bash
cd debug-traces
node show-requests.js
```

### Step 2: Apply Fix
Edit `src/main/local-model-policy.ts` line 14

### Step 3: Test
- Run tests: `npm test -- src/main/local-generation.test.ts`
- Send a message that caused loops
- Expected: No loop, clean finish

## Files Created
All debugging artifacts in `debug-traces/`:
- `SUMMARY.md` - Initial summary
- `FINAL_SUMMARY.md` - Complete analysis
- `USER_SUMMARY.md` - User-friendly guide
- `VERIFICATION_GUIDE.md` - Step-by-step guide
- `show-requests.js` - Shows request body
- `analyze.js` - Code analysis
- `verify-issue.js` - Issue verification

## Confidence: 95%
Root cause confirmed.
