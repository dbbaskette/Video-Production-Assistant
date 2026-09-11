import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ideationApi } from '../lib/api.js';
import { flushPromises, renderComponent } from './component-test-utils.js';
import { Ideation } from '../pages/Ideation.js';

const SESSION = {
  projectId: '11111111-1111-4111-8111-111111111111',
  messages: [],
  proposedScenes: [],
};

function renderIdeation() {
  return renderComponent(
    <MemoryRouter initialEntries={['/project/p1/ideation']}>
      <Routes>
        <Route path="/project/:projectId/ideation" element={<Ideation />} />
      </Routes>
    </MemoryRouter>,
  );
}

function typeMessage(container: HTMLElement, text: string) {
  const textarea = container.querySelector('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function clickSend(container: HTMLElement) {
  act(() => [...container.querySelectorAll('button')]
    .find((button) => button.textContent === 'Send')!.click());
}

describe('Ideation send failure recovery', () => {
  beforeEach(() => {
    // jsdom doesn't implement scrollIntoView (auto-scroll effect).
    Element.prototype.scrollIntoView = vi.fn();
    vi.spyOn(ideationApi, 'getSession').mockResolvedValue(SESSION);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('restores the message into the input and shows a retry banner when sending fails', async () => {
    vi.spyOn(ideationApi, 'sendMessage').mockRejectedValue(new Error('model offline'));
    const view = renderIdeation();
    await flushPromises();

    typeMessage(view.container, 'Demo the new billing page');
    clickSend(view.container);
    await flushPromises();

    // The input was cleared optimistically, then restored on failure — the
    // user's text is never lost.
    const textarea = view.container.querySelector('textarea')! as HTMLTextAreaElement;
    expect(textarea.value).toBe('Demo the new billing page');

    const alert = view.container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("couldn't be sent");
    expect(alert.textContent).toContain('Retry');

    // The failed turn produced no phantom chat messages.
    expect(view.container.textContent).not.toContain('Thinking…');
    view.unmount();
  });

  it('retries the preserved message and clears the banner on success', async () => {
    const sendMessage = vi.spyOn(ideationApi, 'sendMessage')
      .mockRejectedValueOnce(new Error('model offline'))
      .mockResolvedValueOnce({
        id: 'm1',
        role: 'assistant',
        content: 'Here is a plan…',
        timestamp: '2026-08-21T00:00:00Z',
      });
    vi.mocked(ideationApi.getSession)
      .mockResolvedValueOnce(SESSION)
      .mockResolvedValue({
        ...SESSION,
        messages: [{ id: 'm1', role: 'assistant' as const, content: 'Here is a plan…', timestamp: '2026-08-21T00:00:00Z' }],
      });

    const view = renderIdeation();
    await flushPromises();

    typeMessage(view.container, 'Demo the new billing page');
    clickSend(view.container);
    await flushPromises();

    const retry = [...view.container.querySelectorAll<HTMLButtonElement>('[role="alert"] button')]
      .find((button) => button.textContent === 'Retry')!;
    act(() => retry.click());
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith('p1', 'Demo the new billing page');
    // Success clears both the input and the failure banner.
    expect((view.container.querySelector('textarea')! as HTMLTextAreaElement).value).toBe('');
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    view.unmount();
  });

  it('dismisses the banner without resending', async () => {
    vi.spyOn(ideationApi, 'sendMessage').mockRejectedValue(new Error('model offline'));
    const view = renderIdeation();
    await flushPromises();

    typeMessage(view.container, 'A one-off question');
    clickSend(view.container);
    await flushPromises();

    const dismiss = [...view.container.querySelectorAll<HTMLButtonElement>('[role="alert"] button')]
      .find((button) => button.getAttribute('aria-label') === 'Dismiss')!;
    act(() => dismiss.click());
    await flushPromises();

    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    view.unmount();
  });

  it('does not restore or show a banner when the send succeeds', async () => {
    vi.spyOn(ideationApi, 'sendMessage').mockResolvedValue({
      id: 'm1',
      role: 'assistant',
      content: 'ok',
      timestamp: '2026-08-21T00:00:00Z',
    });
    const view = renderIdeation();
    await flushPromises();

    typeMessage(view.container, 'All good');
    clickSend(view.container);
    await flushPromises();

    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect((view.container.querySelector('textarea')! as HTMLTextAreaElement).value).toBe('');
    view.unmount();
  });
});
