import { expect, it } from 'vitest';
import { z } from 'zod';
import { toolError } from './tool-outcome';

it('keeps unrelated validation feedback focused on the actual field', () => {
  const result=z.object({requirements:z.array(z.string())}).safeParse({requirements:'bad'});
  expect(result.success).toBe(false);
  const message=toolError((result as any).error);
  expect(message).toContain('requirements');expect(message).not.toContain('revision tokens');
});
it('explains revision handling for existing and new files only when relevant', () => {
  const result=z.object({revision:z.string().uuid()}).safeParse({revision:null});
  expect(toolError((result as any).error)).toContain('expectedHash:null and omit revision');
});
