import { describeError } from '../../source/core/bug-report.js';

/** The error view's reading of `err` (#225), and the errno codes along its cause chain. */
export function asShown(err: unknown) {
  const shown = describeError(err, '0.0.0-test');
  const chain: unknown[] = [];
  for (let e: unknown = err; e && chain.length < 10; e = (e as { cause?: unknown }).cause) chain.push(e);
  return { shown, errnos: chain.map((e) => (e as { code?: unknown }).code) };
}
