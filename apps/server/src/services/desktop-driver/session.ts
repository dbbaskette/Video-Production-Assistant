import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DESKTOP_DRIVER_KEYS,
  DESKTOP_DRIVER_MAX_ELEMENTS,
  DESKTOP_DRIVER_MAX_TEXT_LENGTH,
  type DesktopDriverAction,
  type DesktopDriverActionResult,
  type DesktopDriverCapability,
  type DesktopDriverElement,
  type DesktopDriverOperation,
  type DesktopDriverPlatform,
  type DesktopDriverPlatformElement,
  type DesktopDriverPlatformSnapshot,
  type DesktopDriverSessionCreateInput,
  type DesktopDriverWindowOwnerSessionCreateInput,
  type DesktopDriverSnapshot,
  type ResolvedDesktopDriverTarget,
} from './types.js';

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_TTL_MS = 60 * 60_000;
const REDACTED = '[REDACTED]';
const ALLOWED_OPERATIONS = new Set<DesktopDriverOperation>([
  'inspect', 'screenshot', 'click', 'set-value', 'type-text', 'press-key',
]);

const EXCLUDED_BUNDLE_IDS = new Set([
  'com.apple.terminal',
  'com.apple.systempreferences',
  'com.apple.systemsettings',
  'com.apple.keychainaccess',
  'com.googlecode.iterm2',
  'dev.warp.warp-stable',
  'com.openai.chat',
  'com.openai.codex',
  'so.cap.desktop',
  'com.bitwarden.desktop',
  'com.lastpass.lastpass',
  'com.1password.1password',
]);

const EXCLUDED_NAME_PATTERNS = [
  /^terminal$/i,
  /^iterm2?$/i,
  /^warp$/i,
  /^chatgpt$/i,
  /^codex$/i,
  /^cap$/i,
  /^cap desktop$/i,
  /^video production assistant$/i,
  /^vpa$/i,
  /^system (settings|preferences)$/i,
  /^keychain access$/i,
  /password/i,
  /^1password$/i,
  /^bitwarden$/i,
  /^lastpass$/i,
  /^keeper$/i,
  /^dashlane$/i,
];

const SENSITIVE_CONTROL_PATTERN = /\b(delete|remove|erase|destroy|publish|upload|share|send|post|purchase|buy|checkout|pay|password|credential|sign[ -]?in|log[ -]?in)\b/i;

export type DesktopDriverErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN_TARGET'
  | 'OPERATION_NOT_ALLOWED'
  | 'STALE_SNAPSHOT'
  | 'TARGET_CHANGED';

export class DesktopDriverError extends Error {
  constructor(
    public readonly code: DesktopDriverErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DesktopDriverError';
  }
}

interface SnapshotState {
  generation: number;
  platform: DesktopDriverPlatformSnapshot;
  elementsByIndex: Map<number, DesktopDriverPlatformElement>;
  fingerprint: string;
}

interface StoredDesktopDriverSession {
  id: string;
  tokenHash: Buffer;
  agentRecordingSessionId: string;
  projectId: string;
  sceneId: string;
  planFingerprint: string;
  phase: 'rehearsal' | 'recording';
  target: ResolvedDesktopDriverTarget;
  operations: Set<DesktopDriverOperation>;
  expiresAt: number;
  revoked: boolean;
  tempDirectory: string;
  screenshots: Set<string>;
  generation: number;
  snapshot?: SnapshotState;
  queueTail: Promise<void>;
  abortController: AbortController;
  cleanupPromise?: Promise<void>;
}

export interface DesktopDriverSessionManagerOptions {
  platform: DesktopDriverPlatform;
  now?: () => Date;
  randomToken?: () => Buffer;
  randomId?: () => string;
  makeTempDirectory?: (prefix: string) => Promise<string>;
  remove?: (path: string) => Promise<void>;
}

function hashToken(token: string | Buffer): Buffer {
  return createHash('sha256').update(token).digest();
}

function isExcludedTarget(bundleId: string, displayName: string): boolean {
  const normalizedBundleId = bundleId.trim();
  const normalizedName = displayName.trim();
  return EXCLUDED_BUNDLE_IDS.has(normalizedBundleId.toLowerCase())
    || normalizedBundleId.toLowerCase().includes('password')
    || EXCLUDED_NAME_PATTERNS.some((pattern) => pattern.test(normalizedName));
}

function assertNonEmpty(value: unknown, label: string, maxLength = 1_000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || value.includes('\0')) {
    throw new DesktopDriverError('INVALID_REQUEST', `${label} is invalid`);
  }
}

function assertTargetInput(input: DesktopDriverSessionCreateInput): void {
  assertNonEmpty(input.agentRecordingSessionId, 'Agent recording session ID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.agentRecordingSessionId)) {
    throw new DesktopDriverError('INVALID_REQUEST', 'Agent recording session ID is invalid');
  }
  assertNonEmpty(input.projectId, 'Project ID');
  assertNonEmpty(input.sceneId, 'Scene ID');
  assertNonEmpty(input.planFingerprint, 'Plan fingerprint');
  assertNonEmpty(input.target.bundleId, 'Target bundle ID');
  assertNonEmpty(input.target.displayName, 'Target display name');
  assertNonEmpty(input.target.windowTitle, 'Target window title');
  if (!Number.isSafeInteger(input.target.windowId) || input.target.windowId <= 0) {
    throw new DesktopDriverError('INVALID_REQUEST', 'Target window ID is invalid');
  }
  if (input.target.processId !== undefined
    && (!Number.isSafeInteger(input.target.processId) || input.target.processId <= 0)) {
    throw new DesktopDriverError('INVALID_REQUEST', 'Target process ID is invalid');
  }
  if (isExcludedTarget(input.target.bundleId, input.target.displayName)) {
    throw new DesktopDriverError('FORBIDDEN_TARGET', 'That application cannot be controlled');
  }
}

function assertResolvedTarget(target: ResolvedDesktopDriverTarget): void {
  if (!Number.isSafeInteger(target.processId) || target.processId <= 0) {
    throw new DesktopDriverError('TARGET_CHANGED', 'Target process could not be verified');
  }
  const { x, y, width, height } = target.bounds;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new DesktopDriverError('TARGET_CHANGED', 'Target window bounds could not be verified');
  }
  if (isExcludedTarget(target.bundleId, target.displayName)) {
    throw new DesktopDriverError('FORBIDDEN_TARGET', 'That application cannot be controlled');
  }
}

function targetIdentity(target: ResolvedDesktopDriverTarget): string {
  return [target.bundleId, target.displayName, target.processId, target.windowId, target.windowTitle].join('\u0000');
}

function assertSameTarget(expected: ResolvedDesktopDriverTarget, actual: ResolvedDesktopDriverTarget): void {
  assertResolvedTarget(actual);
  if (targetIdentity(expected) !== targetIdentity(actual)) {
    throw new DesktopDriverError('TARGET_CHANGED', 'Approved target identity changed');
  }
}

function boundedText(value: string | undefined, max = 500): string | undefined {
  if (value === undefined) return undefined;
  return value.replaceAll('\0', '').slice(0, max);
}

function sanitizeElement(element: DesktopDriverPlatformElement, index: number): DesktopDriverElement {
  const actions = Array.from(new Set(element.actions.filter((action) => typeof action === 'string')))
    .slice(0, 20)
    .map((action) => boundedText(action, 100) ?? '');
  return {
    index,
    role: boundedText(element.role, 200) ?? '',
    title: boundedText(element.title, 500) ?? '',
    ...(element.secure ? { value: REDACTED } : { value: boundedText(element.value) }),
    enabled: element.enabled === true,
    actions,
  };
}

function snapshotFingerprint(snapshot: DesktopDriverPlatformSnapshot): string {
  const elements = snapshot.elements.slice(0, DESKTOP_DRIVER_MAX_ELEMENTS).map((element) => ({
    path: element.reference.path,
    role: element.role,
    title: element.title,
    value: element.secure ? REDACTED : element.value,
    enabled: element.enabled,
    actions: element.actions,
    secure: element.secure === true,
    focused: element.focused === true,
  }));
  return createHash('sha256').update(JSON.stringify({
    target: {
      identity: targetIdentity(snapshot.target),
      bounds: snapshot.target.bounds,
      windowFocused: snapshot.windowFocused,
    },
    elements,
  })).digest('hex');
}

function validateElementReference(element: DesktopDriverPlatformElement): void {
  if (!Array.isArray(element.reference?.path)
    || element.reference.path.length > 64
    || element.reference.path.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    throw new DesktopDriverError('TARGET_CHANGED', 'Accessibility snapshot contained an invalid element reference');
  }
}

export class DesktopDriverSessionManager {
  private readonly sessions = new Map<string, StoredDesktopDriverSession>();
  private readonly now: () => Date;
  private readonly randomToken: () => Buffer;
  private readonly randomId: () => string;
  private readonly makeTempDirectory: (prefix: string) => Promise<string>;
  private readonly remove: (path: string) => Promise<void>;

  constructor(private readonly options: DesktopDriverSessionManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.randomToken = options.randomToken ?? (() => randomBytes(32));
    this.randomId = options.randomId ?? randomUUID;
    this.makeTempDirectory = options.makeTempDirectory ?? ((prefix) => mkdtemp(prefix));
    this.remove = options.remove ?? (async (path) => { await rm(path, { recursive: true, force: true }); });
  }

  async createFromWindowOwner(input: DesktopDriverWindowOwnerSessionCreateInput): Promise<DesktopDriverCapability> {
    assertTargetInput({ ...input, target: { ...input.target, bundleId: 'local.vpa.pending-target' } });
    assertNonEmpty(input.target.displayName, 'Target display name');
    assertNonEmpty(input.target.windowTitle, 'Target window title');
    if (!Number.isSafeInteger(input.target.windowId) || input.target.windowId <= 0) throw new DesktopDriverError('INVALID_REQUEST', 'Target window ID is invalid');
    if (isExcludedTarget('', input.target.displayName)) throw new DesktopDriverError('FORBIDDEN_TARGET', 'That application cannot be controlled');
    if (!this.options.platform.resolveWindowOwnerTarget) throw new DesktopDriverError('TARGET_CHANGED', 'Target application identity could not be resolved');
    const resolved = await this.options.platform.resolveWindowOwnerTarget({ ...input.target });
    assertResolvedTarget(resolved);
    if (resolved.displayName !== input.target.displayName || resolved.windowId !== input.target.windowId || resolved.windowTitle !== input.target.windowTitle) {
      throw new DesktopDriverError('TARGET_CHANGED', 'Resolved application does not match the Cap target');
    }
    return this.create({ ...input, target: resolved });
  }

  async create(input: DesktopDriverSessionCreateInput): Promise<DesktopDriverCapability> {
    assertTargetInput(input);
    const operations = new Set(input.operations);
    if (operations.size === 0 || [...operations].some((operation) => !ALLOWED_OPERATIONS.has(operation))) {
      throw new DesktopDriverError('INVALID_REQUEST', 'Desktop operation set is invalid');
    }
    const ttlMs = input.expiresAt
      ? input.expiresAt.getTime() - this.now().getTime()
      : (input.ttlMs ?? DEFAULT_TTL_MS);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
      throw new DesktopDriverError('INVALID_REQUEST', 'Desktop capability expiry is invalid');
    }

    const target = await this.options.platform.resolveTarget({ ...input.target });
    assertResolvedTarget(target);
    if (input.target.bundleId !== target.bundleId
      || input.target.displayName !== target.displayName
      || input.target.windowId !== target.windowId
      || input.target.windowTitle !== target.windowTitle
      || (input.target.processId !== undefined && input.target.processId !== target.processId)) {
      throw new DesktopDriverError('TARGET_CHANGED', 'Resolved application does not match the approved target');
    }

    const tokenBytes = this.randomToken();
    if (tokenBytes.byteLength !== 32) throw new Error('Desktop capability generator must return 256 bits');
    const token = tokenBytes.toString('base64url');
    const id = this.randomId();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      || this.sessions.has(id)) {
      throw new Error('Desktop capability generator returned an invalid or duplicate session ID');
    }
    const tempDirectory = await this.makeTempDirectory(join(tmpdir(), 'vpa-desktop-driver-'));
    if (!isAbsolute(tempDirectory)) throw new Error('Desktop session directory must be absolute');
    const session: StoredDesktopDriverSession = {
      id,
      tokenHash: hashToken(token),
      agentRecordingSessionId: input.agentRecordingSessionId,
      projectId: input.projectId,
      sceneId: input.sceneId,
      planFingerprint: input.planFingerprint,
      phase: input.phase,
      target,
      operations,
      expiresAt: this.now().getTime() + ttlMs,
      revoked: false,
      tempDirectory,
      screenshots: new Set(),
      generation: 0,
      queueTail: Promise.resolve(),
      abortController: new AbortController(),
    };
    this.sessions.set(id, session);
    return {
      sessionId: id,
      token,
      expiresAt: new Date(session.expiresAt).toISOString(),
      target: { ...target, bounds: { ...target.bounds } },
      operations: [...operations],
    };
  }

  async inspect(sessionId: string, token: string): Promise<DesktopDriverSnapshot> {
    return this.withSerializedOperation(sessionId, token, 'inspect', async (session, signal) => {
      session.snapshot = undefined;
      const platformSnapshot = await this.options.platform.inspect(session.target, signal);
      this.assertActive(session);
      assertSameTarget(session.target, platformSnapshot.target);
      const bounded = platformSnapshot.elements.slice(0, DESKTOP_DRIVER_MAX_ELEMENTS);
      bounded.forEach(validateElementReference);
      if (bounded.filter((element) => element.focused).length > 1) {
        throw new DesktopDriverError('TARGET_CHANGED', 'Accessibility snapshot reported multiple focused elements');
      }
      session.generation += 1;
      const indexBase = (session.generation - 1) * DESKTOP_DRIVER_MAX_ELEMENTS;
      if (!Number.isSafeInteger(indexBase + bounded.length)) {
        throw new DesktopDriverError('STALE_SNAPSHOT', 'Accessibility snapshot generation limit reached');
      }
      const elementsByIndex = new Map<number, DesktopDriverPlatformElement>();
      let focusedElementIndex: number | undefined;
      const elements = bounded.map((element, offset) => {
        const index = indexBase + offset;
        elementsByIndex.set(index, element);
        if (element.focused) focusedElementIndex = index;
        return sanitizeElement(element, index);
      });
      session.snapshot = {
        generation: session.generation,
        platform: platformSnapshot,
        elementsByIndex,
        fingerprint: snapshotFingerprint(platformSnapshot),
      };
      return {
        generation: session.generation,
        target: {
          bundleId: session.target.bundleId,
          displayName: session.target.displayName,
          windowId: session.target.windowId,
          windowTitle: session.target.windowTitle,
        },
        windowBounds: { ...platformSnapshot.target.bounds },
        windowFocused: platformSnapshot.windowFocused,
        ...(focusedElementIndex === undefined ? {} : { focusedElementIndex }),
        elements,
      };
    });
  }

  async screenshot(sessionId: string, token: string): Promise<{ path: string }> {
    return this.withSerializedOperation(sessionId, token, 'screenshot', async (session, signal) => {
      const screenshotId = this.randomId();
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(screenshotId)) {
        throw new Error('Desktop screenshot generator returned an invalid ID');
      }
      const outputPath = join(session.tempDirectory, `window-${screenshotId}.png`);
      if (!isAbsolute(outputPath) || !outputPath.startsWith(`${session.tempDirectory}/`)) {
        throw new Error('Desktop screenshot path escaped its session directory');
      }
      await this.options.platform.screenshot(session.target, outputPath, signal);
      this.assertActive(session);
      session.screenshots.add(outputPath);
      return { path: outputPath };
    });
  }

  async act(sessionId: string, token: string, action: DesktopDriverAction): Promise<DesktopDriverActionResult> {
    this.validateAction(action);
    return this.withSerializedOperation(sessionId, token, action.kind, async (session, signal) => {
      const snapshot = session.snapshot;
      if (!snapshot) throw new DesktopDriverError('STALE_SNAPSHOT', 'Inspect again before acting');
      if (!snapshot.platform.windowFocused) {
        session.snapshot = undefined;
        throw new DesktopDriverError('STALE_SNAPSHOT', 'The approved window is not focused; inspect again');
      }

      let element: DesktopDriverPlatformElement | undefined;
      if (action.kind === 'click' || action.kind === 'set-value') {
        element = snapshot.elementsByIndex.get(action.elementIndex);
        if (!element) throw new DesktopDriverError('STALE_SNAPSHOT', 'Inspect again before using that element index');
        this.assertSafeElement(element);
        if (action.kind === 'click'
          && !element.actions.some((name) => /^(AXPress|press|click)$/i.test(name))) {
          throw new DesktopDriverError('OPERATION_NOT_ALLOWED', 'Accessibility element is not clickable');
        }
        if (action.kind === 'set-value') this.assertEditableElement(element);
      } else {
        element = [...snapshot.elementsByIndex.values()].find((candidate) => candidate.focused);
        if (action.kind === 'type-text') {
          if (!element) throw new DesktopDriverError('STALE_SNAPSHOT', 'Inspect a focused editable control before typing');
          this.assertSafeElement(element);
          this.assertEditableElement(element);
        }
        if (action.kind === 'press-key' && (action.key === 'Return' || action.key === 'space')) {
          if (!element) throw new DesktopDriverError('STALE_SNAPSHOT', 'Inspect a focused control before activating it');
          this.assertSafeElement(element);
          if (!element.actions.some((name) => /^AXPress$/i.test(name))) {
            throw new DesktopDriverError(
              'OPERATION_NOT_ALLOWED',
              'Return and space can activate only the focused pressable control',
            );
          }
        }
      }

      // Reserve the generation before any asynchronous verification so a
      // concurrent action cannot reuse it and a concurrent inspect is ordered.
      session.snapshot = undefined;
      const current = await this.options.platform.inspect(session.target, signal);
      this.assertActive(session);
      assertSameTarget(session.target, current.target);
      if (snapshot.fingerprint !== snapshotFingerprint(current)) {
        throw new DesktopDriverError('STALE_SNAPSHOT', 'The application changed; inspect again before acting');
      }
      await this.options.platform.act(session.target, action, element, signal);
      this.assertActive(session);
      return { ok: true, snapshotInvalidated: true };
    });
  }

  async revoke(agentRecordingSessionId: string, driverSessionId: string): Promise<void> {
    const session = this.sessions.get(driverSessionId);
    if (!session) return;
    if (typeof agentRecordingSessionId !== 'string'
      || !agentRecordingSessionId.trim()
      || session.agentRecordingSessionId !== agentRecordingSessionId) {
      throw new DesktopDriverError('UNAUTHORIZED', 'Desktop capability is not bound to that recording session');
    }
    if (!session.revoked) {
      session.revoked = true;
      session.snapshot = undefined;
      session.abortController.abort();
    }
    session.cleanupPromise ??= (async () => {
      await session.queueTail.catch(() => undefined);
      await this.remove(session.tempDirectory);
      if (this.sessions.get(driverSessionId) === session) this.sessions.delete(driverSessionId);
    })();
    try {
      await session.cleanupPromise;
    } catch (error) {
      // Retain the revoked tombstone and its directory for an exact retry.
      session.cleanupPromise = undefined;
      throw error;
    }
  }

  private async withSerializedOperation<T>(
    sessionId: string,
    token: string,
    operation: DesktopDriverOperation,
    task: (session: StoredDesktopDriverSession, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const session = this.authorize(sessionId, token, operation);
    const previous = session.queueTail.catch(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    session.queueTail = previous.then(() => gate);
    await previous;
    try {
      const authorized = this.authorize(sessionId, token, operation);
      if (authorized !== session) throw new DesktopDriverError('UNAUTHORIZED', 'Desktop capability changed');
      return await task(session, session.abortController.signal);
    } finally {
      release();
    }
  }

  private assertActive(session: StoredDesktopDriverSession): void {
    if (this.sessions.get(session.id) !== session
      || session.revoked
      || session.abortController.signal.aborted
      || this.now().getTime() >= session.expiresAt) {
      throw new DesktopDriverError('UNAUTHORIZED', 'Desktop capability is invalid or expired');
    }
  }

  private assertSafeElement(element: DesktopDriverPlatformElement): void {
    if (!element.enabled) throw new DesktopDriverError('INVALID_REQUEST', 'Accessibility element is disabled');
    if (element.secure || SENSITIVE_CONTROL_PATTERN.test(`${element.role} ${element.title}`)) {
      throw new DesktopDriverError('OPERATION_NOT_ALLOWED', 'Sensitive or destructive controls cannot be operated');
    }
  }

  private assertEditableElement(element: DesktopDriverPlatformElement): void {
    if (!/^(AXTextField|AXTextArea|AXSearchField|AXComboBox)$/i.test(element.role)) {
      throw new DesktopDriverError('OPERATION_NOT_ALLOWED', 'Accessibility element is not an editable text control');
    }
  }

  private authorize(
    sessionId: string,
    token: string,
    operation: DesktopDriverOperation,
  ): StoredDesktopDriverSession {
    const session = this.sessions.get(sessionId);
    // Always hash and compare equal-length values, including unknown sessions,
    // so capability rejection does not use a plain string comparison.
    const suppliedHash = hashToken(typeof token === 'string' ? token : '');
    const expectedHash = session?.tokenHash ?? Buffer.alloc(32);
    const tokenMatches = timingSafeEqual(expectedHash, suppliedHash);
    if (!session
      || !tokenMatches
      || !session.agentRecordingSessionId.trim()
      || session.revoked
      || this.now().getTime() >= session.expiresAt) {
      throw new DesktopDriverError('UNAUTHORIZED', 'Desktop capability is invalid or expired');
    }
    if (!session.operations.has(operation)) {
      throw new DesktopDriverError('OPERATION_NOT_ALLOWED', 'Desktop operation is not allowed');
    }
    return session;
  }

  private validateAction(action: DesktopDriverAction): void {
    if (!action || typeof action !== 'object') {
      throw new DesktopDriverError('INVALID_REQUEST', 'Desktop action is invalid');
    }
    if (action.kind === 'click' || action.kind === 'set-value') {
      if (!Number.isSafeInteger(action.elementIndex) || action.elementIndex < 0) {
        throw new DesktopDriverError('INVALID_REQUEST', 'Element index is invalid');
      }
    }
    if (action.kind === 'set-value' || action.kind === 'type-text') {
      if (typeof action.value !== 'string'
        || action.value.length > DESKTOP_DRIVER_MAX_TEXT_LENGTH
        || /[\u0000-\u001f\u007f-\u009f]/u.test(action.value)) {
        throw new DesktopDriverError('INVALID_REQUEST', 'Text value is invalid or too long');
      }
    }
    if (action.kind === 'press-key' && !(DESKTOP_DRIVER_KEYS as readonly string[]).includes(action.key)) {
      throw new DesktopDriverError('INVALID_REQUEST', 'Key is not allowed');
    }
    if (!['click', 'set-value', 'type-text', 'press-key'].includes(action.kind)) {
      throw new DesktopDriverError('INVALID_REQUEST', 'Desktop action is not allowed');
    }
  }
}
