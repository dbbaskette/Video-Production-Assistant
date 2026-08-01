import { access } from 'node:fs/promises';
import {
  runJsonlProcess,
  type JsonlProcessRequest,
  type JsonlProcessResult,
} from '../process/jsonl-process.js';
import type {
  DesktopDriverAction,
  DesktopDriverPlatform,
  DesktopDriverPlatformElement,
  DesktopDriverPlatformSnapshot,
  DesktopDriverTargetRequest,
  ResolvedDesktopDriverTarget,
} from './types.js';

const OSASCRIPT = '/usr/bin/osascript';
const SCREENCAPTURE = '/usr/sbin/screencapture';
const PROCESS_TIMEOUT_MS = 15_000;

// These programs are intentionally fixed source. All target, element and text
// values are decoded from JSON on stdin and never become executable source.
const JXA_PREAMBLE = String.raw`
ObjC.import('Foundation');
ObjC.import('CoreGraphics');
function input() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  return JSON.parse(text);
}
function output(value) { return JSON.stringify(value); }
function valueOr(value, fallback) { try { const result = value(); return result == null ? fallback : result; } catch (_) { return fallback; } }
function processFor(se, target) {
  const processes = se.applicationProcesses();
  const matches = processes.filter(function (process) {
    return valueOr(process.bundleIdentifier, '') === target.bundleId &&
      Number(valueOr(process.unixId, -1)) === target.processId;
  });
  if (matches.length !== 1) throw new Error('Approved application is not uniquely available');
  const process = matches[0];
  if (valueOr(process.name, '') !== target.displayName) throw new Error('Approved application identity changed');
  return process;
}
function attribute(element, name, fallback) {
  try {
    const matches = element.attributes.whose({ name: name })();
    return matches.length ? valueOr(matches[0].value, fallback) : fallback;
  } catch (_) { return fallback; }
}
function cgWindowFor(target) {
  const raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID);
  const windows = ObjC.deepUnwrap(raw);
  const matches = windows.filter(function (window) {
    return Number(window.kCGWindowNumber) === target.windowId &&
      Number(window.kCGWindowOwnerPID) === target.processId;
  });
  if (matches.length !== 1) throw new Error('Approved window ID is not owned by the approved application');
  const window = matches[0];
  if (window.kCGWindowName && String(window.kCGWindowName) !== target.windowTitle) {
    throw new Error('Approved window identity changed');
  }
  return window;
}
function cgBounds(window) {
  const bounds = window.kCGWindowBounds || {};
  return {
    x: Number(bounds.X), y: Number(bounds.Y),
    width: Number(bounds.Width), height: Number(bounds.Height)
  };
}
function sameBounds(left, right) {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
function windowFor(process, target) {
  const cgWindow = cgWindowFor(target);
  const expectedBounds = cgBounds(cgWindow);
  const windows = process.windows();
  const matches = windows.filter(function (window) {
    return valueOr(window.name, '') === target.windowTitle && sameBounds(boundsFor(window), expectedBounds);
  });
  if (matches.length !== 1) throw new Error('Approved window is not uniquely available');
  return { accessibility: matches[0], bounds: expectedBounds };
}
function boundsFor(window) {
  const position = valueOr(window.position, [0, 0]);
  const size = valueOr(window.size, [0, 0]);
  return { x: Number(position[0]), y: Number(position[1]), width: Number(size[0]), height: Number(size[1]) };
}
function targetResult(target, processId, bounds) {
  return {
    bundleId: target.bundleId, displayName: target.displayName, processId: processId,
    windowId: target.windowId, windowTitle: target.windowTitle, bounds: bounds
  };
}
`;

const RESOLVE_TARGET_JXA = `${JXA_PREAMBLE}
const target = input();
const se = Application('System Events');
const processes = se.applicationProcesses();
const matches = processes.filter(function (process) {
  const bundleMatches = valueOr(process.bundleIdentifier, '') === target.bundleId;
  const nameMatches = valueOr(process.name, '') === target.displayName;
  const pidMatches = target.processId == null || Number(valueOr(process.unixId, -1)) === target.processId;
  return bundleMatches && nameMatches && pidMatches;
});
if (matches.length !== 1) throw new Error('Target application is not uniquely available');
const process = matches[0];
const processId = Number(valueOr(process.unixId, -1));
target.processId = processId;
const cgWindow = cgWindowFor(target);
const expectedBounds = cgBounds(cgWindow);
const windows = process.windows();
const windowMatches = windows.filter(function (window) {
  return valueOr(window.name, '') === target.windowTitle && sameBounds(boundsFor(window), expectedBounds);
});
if (windowMatches.length !== 1) throw new Error('Target window is not uniquely available');
output(targetResult(target, processId, expectedBounds));`;

const INSPECT_TARGET_JXA = `${JXA_PREAMBLE}
const target = input();
const se = Application('System Events');
const process = processFor(se, target);
const resolvedWindow = windowFor(process, target);
const window = resolvedWindow.accessibility;
const windowFocused = Boolean(valueOr(process.frontmost, false)) && Boolean(attribute(window, 'AXMain', false));
const elements = [];
function walk(element, path, depth) {
  if (elements.length >= 500 || depth > 16) return;
  const visible = Boolean(attribute(element, 'AXVisible', true));
  const role = String(valueOr(element.role, ''));
  const title = String(valueOr(element.name, valueOr(element.description, '')));
  const enabled = Boolean(valueOr(element.enabled, true));
  const actionNames = valueOr(function () { return element.actions.name(); }, []);
  const secure = role === 'AXSecureTextField';
  const focused = Boolean(attribute(element, 'AXFocused', false));
  const rawValue = secure ? undefined : valueOr(element.value, undefined);
  if (visible && (role || title || actionNames.length)) {
    elements.push({
      reference: { path: path }, role: role, title: title,
      value: rawValue == null ? undefined : String(rawValue).slice(0, 500),
      enabled: enabled, actions: actionNames.map(String), secure: secure, focused: focused
    });
  }
  const children = valueOr(element.uiElements, []);
  for (let index = 0; index < children.length && elements.length < 500; index += 1) {
    walk(children[index], path.concat(index), depth + 1);
  }
}
walk(window, [], 0);
output({ target: targetResult(target, target.processId, resolvedWindow.bounds), windowFocused: windowFocused, elements: elements });`;

const ACT_TARGET_JXA = `${JXA_PREAMBLE}
const request = input();
const target = request.target;
const se = Application('System Events');
const process = processFor(se, target);
const window = windowFor(process, target).accessibility;
if (!Boolean(valueOr(process.frontmost, false)) || !Boolean(attribute(window, 'AXMain', false))) {
  throw new Error('Approved window is not focused');
}
function elementAt(path) {
  let element = window;
  for (let index = 0; index < path.length; index += 1) {
    const children = valueOr(element.uiElements, []);
    if (!Number.isInteger(path[index]) || path[index] < 0 || path[index] >= children.length) throw new Error('Accessibility element is stale');
    element = children[path[index]];
  }
  return element;
}
const action = request.action;
let focusedElement = null;
if (request.reference) {
  focusedElement = elementAt(request.reference.path);
  if ((action.kind === 'type-text' || action.kind === 'press-key') && !Boolean(attribute(focusedElement, 'AXFocused', false))) {
    throw new Error('Approved focused element changed');
  }
}
if (action.kind === 'click') {
  const element = focusedElement;
  if (!valueOr(element.enabled, true)) throw new Error('Accessibility element is disabled');
  element.actions.byName('AXPress').perform();
} else if (action.kind === 'set-value') {
  const element = focusedElement;
  if (String(valueOr(element.role, '')) === 'AXSecureTextField') throw new Error('Secure fields cannot be changed');
  element.value = action.value;
} else if (action.kind === 'type-text') {
  if (!focusedElement) throw new Error('Typing requires an approved focused element');
  if (String(valueOr(focusedElement.role, '')) === 'AXSecureTextField') throw new Error('Secure fields cannot receive text');
  se.keystroke(action.value);
} else if (action.kind === 'press-key') {
  const keyCodes = { Tab: 48, Return: 36, Escape: 53, Left: 123, Right: 124, Up: 126, Down: 125, space: 49 };
  if (!Object.prototype.hasOwnProperty.call(keyCodes, action.key)) throw new Error('Key is not allowed');
  se.keyCode(keyCodes[action.key]);
} else { throw new Error('Action is not allowed'); }
output({ ok: true });`;

export interface MacOSDesktopPlatformOptions {
  runProcess?: (request: JsonlProcessRequest) => Promise<JsonlProcessResult>;
  access?: typeof access;
}

async function runJxa<T>(
  runProcess: (request: JsonlProcessRequest) => Promise<JsonlProcessResult>,
  source: string,
  value: unknown,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  const result = await runProcess({
    executable: OSASCRIPT,
    args: ['-l', 'JavaScript', '-e', source],
    cwd: '/',
    stdin: JSON.stringify(value),
    timeoutMs: PROCESS_TIMEOUT_MS,
    signal,
  });
  if (result.events.length !== 1) throw new Error(`${label} returned an invalid result`);
  return result.events[0] as T;
}

function sameTarget(expected: ResolvedDesktopDriverTarget, actual: ResolvedDesktopDriverTarget): boolean {
  return expected.bundleId === actual.bundleId
    && expected.displayName === actual.displayName
    && expected.processId === actual.processId
    && expected.windowId === actual.windowId
    && expected.windowTitle === actual.windowTitle;
}

export function createMacOSDesktopPlatform(options: MacOSDesktopPlatformOptions = {}): DesktopDriverPlatform {
  const runProcess = options.runProcess ?? runJsonlProcess;
  const checkAccess = options.access ?? access;
  return {
    async resolveTarget(target: DesktopDriverTargetRequest) {
      return runJxa<ResolvedDesktopDriverTarget>(runProcess, RESOLVE_TARGET_JXA, target, 'macOS target resolution');
    },
    async inspect(target, signal) {
      const snapshot = await runJxa<DesktopDriverPlatformSnapshot>(runProcess, INSPECT_TARGET_JXA, target, 'macOS accessibility inspection', signal);
      if (!sameTarget(target, snapshot.target)) throw new Error('Approved target identity changed');
      return snapshot;
    },
    async screenshot(target, outputPath, signal) {
      // Re-resolve immediately before capture so a reused OS window number
      // cannot redirect capture to a different application.
      const current = await runJxa<ResolvedDesktopDriverTarget>(runProcess, RESOLVE_TARGET_JXA, target, 'macOS screenshot target resolution', signal);
      if (!sameTarget(target, current)) throw new Error('Approved target identity changed');
      await runProcess({
        executable: SCREENCAPTURE,
        args: ['-x', '-l', String(target.windowId), outputPath],
        cwd: '/',
        stdin: '',
        timeoutMs: PROCESS_TIMEOUT_MS,
        signal,
      });
      await checkAccess(outputPath);
    },
    async act(target, action, element, signal) {
      const needsElement = action.kind === 'click'
        || action.kind === 'set-value'
        || action.kind === 'type-text'
        || (action.kind === 'press-key' && (action.key === 'Return' || action.key === 'space'));
      if (needsElement && !element) throw new Error('Action requires a fresh accessibility element');
      await runJxa(runProcess, ACT_TARGET_JXA, { target, action, reference: element?.reference }, 'macOS accessibility action', signal);
    },
  };
}
