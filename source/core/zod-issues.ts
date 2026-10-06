/**
 * zod's issues as one line for an error message: `key: problem; key: problem`,
 * with `(root)` for an issue on the whole value. Shared by the registry index
 * check and the values check (#346).
 */

import type { z } from 'zod';

export function describeZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}
