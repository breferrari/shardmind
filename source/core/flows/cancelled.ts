/**
 * A run its caller ended before it wrote: a cancelled prompt, or an Ink
 * run superseded by a newer one (#302). Every flow lets it through.
 */
export class FlowCancelled extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'FlowCancelled';
    this.reason = reason;
  }
}
