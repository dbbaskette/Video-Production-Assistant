/**
 * A thin LlmClient wrapper whose inner delegate can be swapped at runtime.
 * All route handlers hold a reference to the SwappableLlm; when the user
 * switches models via the settings API, we swap the inner client.
 */

import type { LlmClient, LlmCompleteOptions, LlmCompletion } from './index.js';

export class SwappableLlm implements LlmClient {
  private inner: LlmClient;
  private label: string;

  constructor(inner: LlmClient, label: string) {
    this.inner = inner;
    this.label = label;
  }

  async complete(opts: LlmCompleteOptions): Promise<LlmCompletion> {
    return this.inner.complete(opts);
  }

  /** Replace the inner client (e.g. after the user switches models) */
  swap(next: LlmClient, label: string): void {
    this.inner = next;
    this.label = label;
  }

  /** Human-readable label for the current model */
  getLabel(): string {
    return this.label;
  }
}
