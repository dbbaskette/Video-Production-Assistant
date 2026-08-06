import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

export function renderComponent(node: ReactNode, client = testQueryClient()) {
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);

  const render = (next: ReactNode) => {
    act(() => {
      root.render(<QueryClientProvider client={client}>{next}</QueryClientProvider>);
    });
  };

  render(node);
  return {
    client,
    container,
    rerender: render,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

export function chooseFile(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
}

export async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
