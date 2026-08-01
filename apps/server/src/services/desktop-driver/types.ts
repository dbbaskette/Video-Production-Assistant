export const DESKTOP_DRIVER_MAX_ELEMENTS = 500;
export const DESKTOP_DRIVER_MAX_TEXT_LENGTH = 2_000;

export const DESKTOP_DRIVER_KEYS = [
  'Tab',
  'Return',
  'Escape',
  'Left',
  'Right',
  'Up',
  'Down',
  'space',
] as const;

export type DesktopDriverKey = (typeof DESKTOP_DRIVER_KEYS)[number];

export type DesktopDriverAction =
  | { kind: 'click'; elementIndex: number }
  | { kind: 'set-value'; elementIndex: number; value: string }
  | { kind: 'type-text'; value: string }
  | { kind: 'press-key'; key: DesktopDriverKey };

export type DesktopDriverOperation =
  | 'inspect'
  | 'screenshot'
  | DesktopDriverAction['kind'];

export interface DesktopWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A target is supplied by trusted coordinator code after matching a Cap
 * target. It is never accepted by the loopback action API.
 */
export interface DesktopDriverTargetRequest {
  bundleId: string;
  displayName: string;
  processId?: number;
  windowId: number;
  windowTitle: string;
}

export interface ResolvedDesktopDriverTarget extends DesktopDriverTargetRequest {
  processId: number;
  bounds: DesktopWindowBounds;
}

export interface DesktopDriverElementReference {
  /** Accessibility child indexes from the matched window root. */
  path: number[];
}

export interface DesktopDriverPlatformElement {
  reference: DesktopDriverElementReference;
  role: string;
  title: string;
  value?: string;
  enabled: boolean;
  actions: string[];
  secure?: boolean;
}

export interface DesktopDriverElement {
  index: number;
  role: string;
  title: string;
  value?: string;
  enabled: boolean;
  actions: string[];
}

export interface DesktopDriverSnapshot {
  generation: number;
  target: {
    bundleId: string;
    displayName: string;
    windowId: number;
    windowTitle: string;
  };
  windowBounds: DesktopWindowBounds;
  elements: DesktopDriverElement[];
}

export interface DesktopDriverPlatformSnapshot {
  target: ResolvedDesktopDriverTarget;
  elements: DesktopDriverPlatformElement[];
}

export interface DesktopDriverPlatform {
  resolveTarget(target: DesktopDriverTargetRequest): Promise<ResolvedDesktopDriverTarget>;
  inspect(target: ResolvedDesktopDriverTarget): Promise<DesktopDriverPlatformSnapshot>;
  screenshot(target: ResolvedDesktopDriverTarget, outputPath: string): Promise<void>;
  act(
    target: ResolvedDesktopDriverTarget,
    action: DesktopDriverAction,
    element?: DesktopDriverPlatformElement,
  ): Promise<void>;
}

export interface DesktopDriverSessionCreateInput {
  projectId: string;
  sceneId: string;
  planFingerprint: string;
  target: DesktopDriverTargetRequest;
  operations: DesktopDriverOperation[];
  phase: 'rehearsal' | 'recording';
  expiresAt?: Date;
  ttlMs?: number;
}

export interface DesktopDriverCapability {
  sessionId: string;
  token: string;
  expiresAt: string;
  target: ResolvedDesktopDriverTarget;
  operations: DesktopDriverOperation[];
}

export interface DesktopDriverActionResult {
  ok: true;
  snapshotInvalidated: true;
}

export const DESKTOP_DRIVER_ENV = {
  baseUrl: 'VPA_DESKTOP_DRIVER_BASE_URL',
  sessionId: 'VPA_DESKTOP_DRIVER_SESSION_ID',
  token: 'VPA_DESKTOP_DRIVER_TOKEN',
} as const;
