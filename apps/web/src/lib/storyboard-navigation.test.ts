// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import type { Scene } from '@vpa/shared';
import {
  canUseSceneShortcut,
  displayedSceneOrder,
  filterStoryboardScenes,
  sceneHasNarrationAudio,
  sceneHasScript,
  sceneNeighbor,
  sceneSelectionAfterRemoval,
} from './storyboard-navigation.js';

const scenes: Scene[] = [
  {
    id: 'desktop-empty',
    name: 'Desktop setup',
    description: 'Open the workspace',
    type: 'desktop',
  },
  {
    id: 'browser-scripted',
    name: 'Browser checkout',
    description: 'Complete checkout in the browser',
    type: 'browser',
    recording: { source: 'recordings/browser.mp4' },
    narration: { script: 'Explain checkout.' },
  },
  {
    id: 'terminal-ready',
    name: 'Terminal deploy',
    description: 'Run the deploy command',
    type: 'terminal',
    recording: { source: 'recordings/terminal.mp4' },
    narration: { script: 'Deploy it.', audio: 'narration/terminal.mp3' },
  },
  {
    id: 'slide-ready',
    name: 'Architecture slide',
    description: 'Show the system map',
    type: 'slide',
    recording: { source: 'presentations/slide.png' },
    narration: {
      script: ' ',
      dialogScript: 'A: Here is the system.',
      chunks: [{ index: 0, text: 'Here is the system.', audio: 'narration/slide.mp3' }],
    },
  },
];

describe('storyboard navigation view model', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('detects scripts and narration audio across every supported field', () => {
    expect(sceneHasScript(scenes[0]!)).toBe(false);
    expect(sceneHasScript(scenes[3]!)).toBe(true);
    expect(sceneHasNarrationAudio(scenes[1]!)).toBe(false);
    expect(sceneHasNarrationAudio(scenes[2]!)).toBe(true);
    expect(sceneHasNarrationAudio(scenes[3]!)).toBe(true);
  });

  it('composes text, type, and readiness filters', () => {
    expect(filterStoryboardScenes(scenes, {
      query: 'CHECKOUT',
      type: 'browser',
      readiness: 'needs-narration',
    }).map((scene) => scene.id)).toEqual(['browser-scripted']);
  });

  it('defines each incomplete readiness filter exactly', () => {
    expect(filterStoryboardScenes(scenes, {
      query: '', type: 'all', readiness: 'needs-recording',
    }).map((scene) => scene.id)).toEqual(['desktop-empty']);
    expect(filterStoryboardScenes(scenes, {
      query: '', type: 'all', readiness: 'needs-script',
    }).map((scene) => scene.id)).toEqual(['desktop-empty']);
    expect(filterStoryboardScenes(scenes, {
      query: '', type: 'all', readiness: 'needs-narration',
    }).map((scene) => scene.id)).toEqual(['browser-scripted']);
  });

  it('pins a filtered-out selection exactly once', () => {
    const order = displayedSceneOrder(scenes, 'terminal-ready', {
      query: '', type: 'browser', readiness: 'all',
    });
    expect(order.map((scene) => scene.id)).toEqual(['terminal-ready', 'browser-scripted']);
  });

  it('does not duplicate a selected scene that already matches', () => {
    const order = displayedSceneOrder(scenes, 'browser-scripted', {
      query: '', type: 'browser', readiness: 'all',
    });
    expect(order.map((scene) => scene.id)).toEqual(['browser-scripted']);
  });

  it('does not wrap neighboring selection', () => {
    expect(sceneNeighbor(scenes, scenes[0]!.id, -1)).toBeNull();
    expect(sceneNeighbor(scenes, scenes[0]!.id, 1)).toBe(scenes[1]!.id);
    expect(sceneNeighbor(scenes, scenes.at(-1)!.id, 1)).toBeNull();
  });

  it.each(['input', 'textarea', 'select', 'button', 'a'])(
    'rejects %s shortcut targets',
    (tag) => {
      expect(canUseSceneShortcut(shortcut('[', document.createElement(tag)))).toBe(false);
    },
  );

  it('rejects contenteditable, menu, dialog, and modified shortcut targets', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    expect(canUseSceneShortcut(shortcut(']', editable))).toBe(false);

    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const menuChild = document.createElement('span');
    menu.append(menuChild);
    expect(canUseSceneShortcut(shortcut(']', menuChild))).toBe(false);
    expect(canUseSceneShortcut({ ...shortcut(']', document.body), metaKey: true })).toBe(false);
    expect(canUseSceneShortcut({ ...shortcut(']', document.body), ctrlKey: true })).toBe(false);
    expect(canUseSceneShortcut({ ...shortcut(']', document.body), altKey: true })).toBe(false);

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    expect(canUseSceneShortcut(shortcut(']', document.body))).toBe(false);
  });

  it('allows unmodified bracket shortcuts on a neutral target', () => {
    expect(canUseSceneShortcut(shortcut('[', document.body))).toBe(true);
    expect(canUseSceneShortcut(shortcut(']', document.body))).toBe(true);
    expect(canUseSceneShortcut(shortcut('x', document.body))).toBe(false);
  });

  it('chooses the same index, prior index, then none after removal', () => {
    expect(sceneSelectionAfterRemoval(
      scenes,
      [scenes[0]!, scenes[2]!, scenes[3]!],
      scenes[1]!.id,
    )).toBe(scenes[2]!.id);
    expect(sceneSelectionAfterRemoval(scenes, scenes.slice(0, 1), scenes[2]!.id))
      .toBe(scenes[0]!.id);
    expect(sceneSelectionAfterRemoval(scenes, [], scenes[0]!.id)).toBeNull();
  });

  it('preserves a selected scene that survives another removal', () => {
    expect(sceneSelectionAfterRemoval(scenes, scenes.slice(1), scenes[2]!.id))
      .toBe(scenes[2]!.id);
  });
});

function shortcut(key: string, target: EventTarget) {
  return {
    key,
    target,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
  };
}
