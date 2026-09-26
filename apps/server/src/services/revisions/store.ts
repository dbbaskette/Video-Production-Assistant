import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  AssetManifestSchema,
  ProjectCommandBatchSchema,
  ProjectCommandResultSchema,
  ProjectRevisionSchema,
  ProjectSchema,
  StoryboardSchema,
  type AssetManifest,
  type Project,
  type ProjectCommand,
  type ProjectCommandBatch,
  type ProjectCommandResult,
  type ProjectRevision,
  type Storyboard,
  normalizeCompositionTimeline,
  SceneCompositionSchema,
  type VisualEffect,
} from '@vpa/shared';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import { dumpYaml, loadYaml } from '../../lib/yaml.js';
import { projectFiles } from '../project/paths.js';

interface RevisionSnapshot {
  version: 1;
  revision: number;
  project: Project;
  storyboard: Storyboard | null;
}

interface IdempotencyRecord {
  payloadHash: string;
  result: ProjectCommandResult;
}

export interface RevisionState {
  version: 1;
  currentRevision: number;
  acceptedRevision: number;
  revisions: ProjectRevision[];
  idempotency: Record<string, IdempotencyRecord>;
}

interface TransactionJournal {
  version: 1;
  id: string;
  targetRevision: number;
  before: { projectYaml: string; storyboardYaml: string | null };
  after: { projectYaml: string; storyboardYaml: string | null };
}

export class RevisionError extends Error {
  constructor(
    public readonly code: 'stale_revision' | 'idempotency_conflict' | 'invalid_command' | 'revision_not_found',
    message: string,
    public readonly currentRevision?: number,
  ) {
    super(message);
    this.name = 'RevisionError';
  }
}

export interface RevisionStoreOptions {
  persist?: typeof atomicWriteFile;
}

const mutationTails = new Map<string, Promise<void>>();

function hashPayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function snapshotName(revision: number): string {
  return `${revision.toString().padStart(10, '0')}.json`;
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export class RevisionStore {
  private readonly persist: typeof atomicWriteFile;

  constructor(private readonly projectRoot: string, opts: RevisionStoreOptions = {}) {
    this.persist = opts.persist ?? atomicWriteFile;
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.projectRoot);
    const previous = mutationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    mutationTails.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (mutationTails.get(key) === current) mutationTails.delete(key);
    }
  }

  private async readDocuments(): Promise<{ project: Project; storyboard: Storyboard | null; projectYaml: string; storyboardYaml: string | null }> {
    const files = projectFiles(this.projectRoot);
    const projectYaml = await readFile(files.metadata, 'utf8');
    const storyboardYaml = await readOptional(files.storyboard);
    return {
      project: loadYaml(projectYaml, ProjectSchema),
      storyboard: storyboardYaml ? loadYaml(storyboardYaml, StoryboardSchema) : null,
      projectYaml,
      storyboardYaml,
    };
  }

  private async readAssets(): Promise<AssetManifest> {
    const raw = await readOptional(projectFiles(this.projectRoot).assetManifest);
    return raw ? AssetManifestSchema.parse(JSON.parse(raw)) : { version: 1, assets: [] };
  }

  private async recoverTransactions(state?: RevisionState): Promise<void> {
    const files = projectFiles(this.projectRoot);
    let names: string[];
    try {
      names = (await readdir(files.revisionTransactionsDir)).filter((name) => name.endsWith('.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const current = state ?? await this.readStateWithoutRecovery();
    for (const name of names) {
      const journalPath = path.join(files.revisionTransactionsDir, name);
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as TransactionJournal;
      const desired = current.currentRevision >= journal.targetRevision ? journal.after : journal.before;
      await this.persist(files.metadata, desired.projectYaml);
      if (desired.storyboardYaml !== null) await this.persist(files.storyboard, desired.storyboardYaml);
      await unlink(journalPath);
    }
  }

  private async readStateWithoutRecovery(): Promise<RevisionState> {
    const files = projectFiles(this.projectRoot);
    const raw = await readOptional(files.revisionState);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RevisionState>;
      const revisions = (parsed.revisions ?? []).map((revision) => ProjectRevisionSchema.parse(revision));
      return {
        version: 1,
        currentRevision: parsed.currentRevision ?? 0,
        acceptedRevision: parsed.acceptedRevision
          ?? [...revisions].reverse().find((revision) => revision.state === 'accepted')?.revision
          ?? 0,
        revisions,
        idempotency: parsed.idempotency ?? {},
      };
    }

    const documents = await this.readDocuments();
    const createdAt = new Date().toISOString();
    const state: RevisionState = {
      version: 1,
      currentRevision: 0,
      acceptedRevision: 0,
      revisions: [{ revision: 0, createdAt, commandTypes: ['bootstrap'], state: 'accepted' }],
      idempotency: {},
    };
    await mkdir(files.revisionSnapshotsDir, { recursive: true });
    await this.persist(path.join(files.revisionSnapshotsDir, snapshotName(0)), JSON.stringify({
      version: 1,
      revision: 0,
      project: documents.project,
      storyboard: documents.storyboard,
    } satisfies RevisionSnapshot, null, 2));
    await this.persist(files.revisionState, JSON.stringify(state, null, 2));
    return state;
  }

  private async reconcileExternalMutation(state: RevisionState): Promise<RevisionState> {
    const current = await this.loadSnapshot(state.currentRevision);
    const documents = await this.readDocuments();
    if (
      JSON.stringify(current.project) === JSON.stringify(documents.project)
      && JSON.stringify(current.storyboard) === JSON.stringify(documents.storyboard)
    ) {
      return state;
    }

    const files = projectFiles(this.projectRoot);
    const revision = state.currentRevision + 1;
    const revisionRecord = ProjectRevisionSchema.parse({
      revision,
      createdAt: new Date().toISOString(),
      commandTypes: ['external-mutation'],
      state: 'accepted',
    });
    const nextState: RevisionState = {
      ...state,
      currentRevision: revision,
      acceptedRevision: revision,
      revisions: [...state.revisions, revisionRecord],
    };
    await this.persist(path.join(files.revisionSnapshotsDir, snapshotName(revision)), JSON.stringify({
      version: 1,
      revision,
      project: documents.project,
      storyboard: documents.storyboard,
    } satisfies RevisionSnapshot, null, 2));
    await this.persist(files.revisionState, JSON.stringify(nextState, null, 2));
    return nextState;
  }

  async readState(): Promise<RevisionState> {
    const state = await this.readStateWithoutRecovery();
    await this.recoverTransactions(state);
    return this.reconcileExternalMutation(state);
  }

  async currentRevision(): Promise<number> {
    return (await this.readState()).currentRevision;
  }

  async listRevisions(): Promise<ProjectRevision[]> {
    return (await this.readState()).revisions.map((revision) => ProjectRevisionSchema.parse(revision));
  }

  private async loadSnapshot(revision: number): Promise<RevisionSnapshot> {
    const snapshotPath = path.join(projectFiles(this.projectRoot).revisionSnapshotsDir, snapshotName(revision));
    try {
      const parsed = JSON.parse(await readFile(snapshotPath, 'utf8')) as RevisionSnapshot;
      return {
        version: 1,
        revision: parsed.revision,
        project: ProjectSchema.parse(parsed.project),
        storyboard: parsed.storyboard ? StoryboardSchema.parse(parsed.storyboard) : null,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RevisionError('revision_not_found', 'The requested revision does not exist.');
      }
      throw error;
    }
  }

  private applyCommand(
    command: ProjectCommand,
    current: { project: Project; storyboard: Storyboard | null },
    assets: AssetManifest,
  ): { project: Project; storyboard: Storyboard | null } {
    if (command.type === 'revision.restore') return current;
    let { project, storyboard } = current;
    if (command.type === 'project.patch') {
      project = ProjectSchema.parse({ ...project, ...command.patch });
      if (storyboard) {
        storyboard = StoryboardSchema.parse({
          ...storyboard,
          project: {
            ...storyboard.project,
            name: project.name,
            objective: project.objective,
            audience: project.audience,
          },
        });
      }
      return { project, storyboard };
    }
    if (!storyboard) throw new RevisionError('invalid_command', 'The project does not have a storyboard.');

    const sceneIndexFor = (sceneId: string): number => {
      const index = storyboard!.scenes.findIndex((scene) => scene.id === sceneId);
      if (index < 0) throw new RevisionError('invalid_command', 'The selected scene does not exist.');
      return index;
    };
    const updateComposition = (
      sceneId: string,
      update: (composition: NonNullable<Storyboard['scenes'][number]['composition']>) => NonNullable<Storyboard['scenes'][number]['composition']>,
      updateEffects: (effects: VisualEffect[]) => VisualEffect[] = (effects) => effects,
    ): void => {
      const index = sceneIndexFor(sceneId);
      const scene = storyboard!.scenes[index]!;
      if (!scene.composition) throw new RevisionError('invalid_command', 'Initialize the scene composition before editing clips.');
      const composition = SceneCompositionSchema.parse(update(scene.composition));
      storyboard = StoryboardSchema.parse({
        ...storyboard,
        scenes: storyboard!.scenes.map((candidate, sceneIndex) => sceneIndex === index ? { ...scene, composition, visual_effects: updateEffects(scene.visual_effects ?? []), overlay_render: undefined, frame_render: undefined } : candidate),
      });
    };

    if (command.type === 'scene.assign-asset') {
      const asset = assets.assets.find((candidate) => candidate.id === command.assetId);
      if (!asset) throw new RevisionError('invalid_command', 'The selected asset does not exist.');
      const index = storyboard.scenes.findIndex((scene) => scene.id === command.sceneId);
      if (index < 0) throw new RevisionError('invalid_command', 'The selected scene does not exist.');
      const scene = storyboard.scenes[index]!;
      const sources = [
        ...(scene.sources ?? []).filter((source) => source.role !== command.role),
        { asset_id: asset.id, role: command.role, timing_origin_ms: command.timingOriginMs },
      ];
      const nextScene = {
        ...scene,
        sources,
        ...(asset.media_kind === 'video' && command.role === 'screen' ? { recording: {
          source: asset.source,
          asset_id: asset.id,
          duration_sec: asset.duration_sec,
          ingested_at: new Date().toISOString(),
          source_kind: 'bulk' as const,
          capture_session_id: asset.capture_session_id,
          source_role: command.role,
          timing_origin_ms: command.timingOriginMs,
        } } : {}),
        ...(command.role === 'screen' ? { composition: undefined, visual_effects: undefined, transcript: undefined, evidence: undefined } : {}),
        overlay_render: undefined,
        frame_render: undefined,
      };
      storyboard = StoryboardSchema.parse({
        ...storyboard,
        scenes: storyboard.scenes.map((candidate, sceneIndex) => sceneIndex === index ? nextScene : candidate),
      });
    } else if (command.type === 'composition.set') {
      const index = sceneIndexFor(command.sceneId);
      const scene = storyboard.scenes[index]!;
      storyboard = StoryboardSchema.parse({
        ...storyboard,
        scenes: storyboard.scenes.map((candidate, sceneIndex) => sceneIndex === index
          ? { ...scene, composition: command.composition, overlay_render: undefined, frame_render: undefined }
          : candidate),
      });
    } else if (command.type === 'clip.trim') {
      if (command.sourceOutMs <= command.sourceInMs) throw new RevisionError('invalid_command', 'Clip out must be after clip in.');
      updateComposition(command.sceneId, (composition) => {
        if (!composition.clips.some((clip) => clip.id === command.clipId)) throw new RevisionError('invalid_command', 'The selected clip does not exist.');
        const clips = composition.clips.map((clip) => clip.id === command.clipId
          ? { ...clip, source_in_ms: command.sourceInMs, source_out_ms: command.sourceOutMs }
          : clip);
        return { ...composition, clips: normalizeCompositionTimeline(clips) };
      }, (effects) => effects.flatMap((effect) => {
        if (effect.clip_instance_id !== command.clipId) return [effect];
        const source_in_ms = Math.max(effect.source_in_ms, command.sourceInMs);
        const source_out_ms = Math.min(effect.source_out_ms, command.sourceOutMs);
        return source_out_ms > source_in_ms ? [{ ...effect, source_in_ms, source_out_ms }] : [];
      }));
    } else if (command.type === 'clip.split') {
      updateComposition(command.sceneId, (composition) => {
        if (command.leftClipId === command.rightClipId || composition.clips.some((clip) => clip.id === command.leftClipId || clip.id === command.rightClipId)) {
          throw new RevisionError('invalid_command', 'Split clip IDs must be new and unique.');
        }
        const index = composition.clips.findIndex((clip) => clip.id === command.clipId);
        if (index < 0) throw new RevisionError('invalid_command', 'The selected clip does not exist.');
        const clip = composition.clips[index]!;
        if (command.splitSourceMs <= clip.source_in_ms || command.splitSourceMs >= clip.source_out_ms) {
          throw new RevisionError('invalid_command', 'Split point must be inside the clip bounds.');
        }
        const clips = [...composition.clips];
        clips.splice(index, 1,
          { ...clip, id: command.leftClipId, source_out_ms: command.splitSourceMs },
          { ...clip, id: command.rightClipId, source_in_ms: command.splitSourceMs },
        );
        return { ...composition, clips: normalizeCompositionTimeline(clips) };
      }, (effects) => effects.flatMap((effect) => {
        if (effect.clip_instance_id !== command.clipId) return [effect];
        return [
          ...(effect.source_in_ms < command.splitSourceMs ? [{ ...effect, id: `effect_${createHash('sha256').update(`${effect.id}:${command.leftClipId}`).digest('hex').slice(0, 16)}`, clip_instance_id: command.leftClipId, source_out_ms: Math.min(effect.source_out_ms, command.splitSourceMs) }] : []),
          ...(effect.source_out_ms > command.splitSourceMs ? [{ ...effect, id: `effect_${createHash('sha256').update(`${effect.id}:${command.rightClipId}`).digest('hex').slice(0, 16)}`, clip_instance_id: command.rightClipId, source_in_ms: Math.max(effect.source_in_ms, command.splitSourceMs) }] : []),
        ];
      }));
    } else if (command.type === 'clip.delete') {
      updateComposition(command.sceneId, (composition) => {
        if (composition.clips.length === 1) throw new RevisionError('invalid_command', 'A composition must keep at least one clip.');
        if (!composition.clips.some((clip) => clip.id === command.clipId)) throw new RevisionError('invalid_command', 'The selected clip does not exist.');
        return { ...composition, clips: normalizeCompositionTimeline(composition.clips.filter((clip) => clip.id !== command.clipId)) };
      }, (effects) => effects.filter((effect) => effect.clip_instance_id !== command.clipId));
    } else if (command.type === 'clip.reorder') {
      updateComposition(command.sceneId, (composition) => {
        if (new Set(command.clipIds).size !== command.clipIds.length) throw new RevisionError('invalid_command', 'Clip reorder contains duplicate IDs.');
        const byId = new Map(composition.clips.map((clip) => [clip.id, clip]));
        if (command.clipIds.length !== composition.clips.length || command.clipIds.some((id) => !byId.has(id))) {
          throw new RevisionError('invalid_command', 'Clip reorder must contain every clip exactly once.');
        }
        return { ...composition, clips: normalizeCompositionTimeline(command.clipIds.map((id) => byId.get(id)!)) };
      });
    } else if (command.type === 'clip.duplicate') {
      updateComposition(command.sceneId, (composition) => {
        if (composition.clips.some((clip) => clip.id === command.newClipId)) throw new RevisionError('invalid_command', 'The new clip ID is already in use.');
        const index = composition.clips.findIndex((clip) => clip.id === command.clipId);
        if (index < 0) throw new RevisionError('invalid_command', 'The selected clip does not exist.');
        const clips = [...composition.clips];
        clips.splice(index + 1, 0, { ...composition.clips[index]!, id: command.newClipId });
        return { ...composition, clips: normalizeCompositionTimeline(clips) };
      }, (effects) => [
        ...effects,
        ...effects.filter((effect) => effect.clip_instance_id === command.clipId).map((effect) => ({
          ...effect,
          id: `effect_${createHash('sha256').update(`${effect.id}:${command.newClipId}`).digest('hex').slice(0, 16)}`,
          clip_instance_id: command.newClipId,
        })),
      ]);
    } else if (command.type === 'audio.mix.set') {
      updateComposition(command.sceneId, (composition) => ({
        ...composition,
        audio_mix: { ...composition.audio_mix, [command.role]: command.settings },
      }));
    } else if (command.type === 'visual.effects.set') {
      const index = sceneIndexFor(command.sceneId);
      const scene = storyboard.scenes[index]!;
      if (!scene.composition) throw new RevisionError('invalid_command', 'Initialize the scene composition before adding visual effects.');
      const clipById = new Map(scene.composition.clips.map((clip) => [clip.id, clip]));
      const ids = new Set<string>();
      for (const effect of command.effects) {
        if (ids.has(effect.id)) throw new RevisionError('invalid_command', 'Visual effect IDs must be unique.');
        ids.add(effect.id);
        const clip = clipById.get(effect.clip_instance_id);
        if (!clip || clip.source_asset_id !== effect.source_asset_id) throw new RevisionError('invalid_command', 'A visual effect must reference its clip source.');
        if (effect.source_in_ms < clip.source_in_ms || effect.source_out_ms > clip.source_out_ms) throw new RevisionError('invalid_command', 'A visual effect must stay inside its clip source interval.');
        if (effect.type === 'logo') {
          const logo = assets.assets.find((asset) => asset.id === effect.asset_id);
          if (!logo || logo.media_kind !== 'image') throw new RevisionError('invalid_command', 'A logo effect requires an immutable image asset.');
        }
      }
      storyboard = StoryboardSchema.parse({
        ...storyboard,
        scenes: storyboard.scenes.map((candidate, sceneIndex) => sceneIndex === index
          ? { ...scene, visual_effects: command.effects, overlay_render: undefined, frame_render: undefined }
          : candidate),
      });
    } else if (command.type === 'transcript.set') {
      const index = sceneIndexFor(command.sceneId);
      const scene = storyboard.scenes[index]!;
      const source = assets.assets.find((asset) => asset.id === command.transcript.source_asset_id);
      if (!source || source.checksum !== command.transcript.source_sha256) throw new RevisionError('invalid_command', 'Transcript provenance does not match an immutable source asset.');
      storyboard = StoryboardSchema.parse({
        ...storyboard,
        scenes: storyboard.scenes.map((candidate, sceneIndex) => sceneIndex === index ? { ...scene, transcript: command.transcript } : candidate),
      });
    } else if (command.type === 'transcript.word.correct') {
      const index = sceneIndexFor(command.sceneId);
      const scene = storyboard.scenes[index]!;
      if (!scene.transcript) throw new RevisionError('invalid_command', 'This scene has no source transcript.');
      if (!scene.transcript.words.some((word) => word.id === command.wordId)) throw new RevisionError('invalid_command', 'The selected transcript word does not exist.');
      const transcript = {
        ...scene.transcript,
        words: scene.transcript.words.map((word) => word.id === command.wordId
          ? { ...word, original_text: word.original_text ?? word.text, text: command.text }
          : word),
      };
      const wordById = new Map(transcript.words.map((word) => [word.id, word]));
      transcript.passages = transcript.passages.map((passage) => ({
        ...passage,
        text: passage.word_ids.map((wordId) => wordById.get(wordId)?.text).filter(Boolean).join(' '),
      }));
      storyboard = StoryboardSchema.parse({
        ...storyboard,
        scenes: storyboard.scenes.map((candidate, sceneIndex) => sceneIndex === index ? { ...scene, transcript } : candidate),
      });
    } else if (command.type === 'scene.put') {
      const index = storyboard.scenes.findIndex((scene) => scene.id === command.scene.id);
      if (index < 0) throw new RevisionError('invalid_command', 'The selected scene does not exist.');
      storyboard = StoryboardSchema.parse({
        ...storyboard,
        scenes: storyboard.scenes.map((scene, sceneIndex) => sceneIndex === index ? command.scene : scene),
      });
    } else if (command.type === 'scene.add') {
      if (storyboard.scenes.some((scene) => scene.id === command.scene.id)) {
        throw new RevisionError('invalid_command', 'A scene with that ID already exists.');
      }
      const scenes = [...storyboard.scenes];
      scenes.splice(command.index ?? scenes.length, 0, command.scene);
      storyboard = StoryboardSchema.parse({ ...storyboard, scenes });
    } else if (command.type === 'scene.delete') {
      if (!storyboard.scenes.some((scene) => scene.id === command.sceneId)) {
        throw new RevisionError('invalid_command', 'The selected scene does not exist.');
      }
      storyboard = StoryboardSchema.parse({
        ...storyboard,
        scenes: storyboard.scenes.filter((scene) => scene.id !== command.sceneId),
      });
    } else if (command.type === 'scene.reorder') {
      if (new Set(command.sceneIds).size !== command.sceneIds.length) {
        throw new RevisionError('invalid_command', 'Scene reorder contains duplicate IDs.');
      }
      const byId = new Map(storyboard.scenes.map((scene) => [scene.id, scene]));
      if (command.sceneIds.length !== storyboard.scenes.length || command.sceneIds.some((id) => !byId.has(id))) {
        throw new RevisionError('invalid_command', 'Scene reorder must contain every scene exactly once.');
      }
      storyboard = StoryboardSchema.parse({ ...storyboard, scenes: command.sceneIds.map((id) => byId.get(id)!) });
    }
    return { project, storyboard };
  }

  private validateAssetReferences(storyboard: Storyboard | null, assets: AssetManifest): void {
    if (!storyboard) return;
    const byId = new Map(assets.assets.map((asset) => [asset.id, asset]));
    for (const scene of storyboard.scenes) {
      if (scene.recording?.asset_id) {
        const asset = byId.get(scene.recording.asset_id);
        if (!asset || asset.source !== scene.recording.source) {
          throw new RevisionError('invalid_command', 'A scene contains an invalid asset reference.');
        }
      }
      for (const source of scene.sources ?? []) {
        if (!byId.has(source.asset_id)) {
          throw new RevisionError('invalid_command', 'A scene contains an invalid source reference.');
        }
      }
      for (const clip of scene.composition?.clips ?? []) {
        const primary = byId.get(clip.source_asset_id);
        if (!primary || !['video', 'image'].includes(primary.media_kind)) {
          throw new RevisionError('invalid_command', 'A clip contains an invalid visual asset reference.');
        }
        if ((clip.source_role === 'image') !== (primary.media_kind === 'image')) {
          throw new RevisionError('invalid_command', 'A clip visual role does not match its asset type.');
        }
        if (primary.duration_sec !== undefined && clip.source_out_ms > Math.round(primary.duration_sec * 1_000)) {
          throw new RevisionError('invalid_command', 'A clip extends beyond its source duration.');
        }
        for (const track of clip.linked_tracks) {
          const asset = byId.get(track.asset_id);
          if (!asset) throw new RevisionError('invalid_command', 'A clip contains an invalid linked asset reference.');
          if (['microphone', 'system-audio', 'narration', 'music'].includes(track.role) && asset.media_kind !== 'audio') {
            throw new RevisionError('invalid_command', 'An audio track must reference an audio asset.');
          }
          const linkedSourceEndMs = Math.max(1, clip.source_out_ms - track.source_offset_ms);
          if (asset.duration_sec !== undefined && linkedSourceEndMs > Math.round(asset.duration_sec * 1_000)) {
            throw new RevisionError('invalid_command', 'A linked track extends beyond its source duration.');
          }
        }
      }
      for (const anchor of scene.composition?.anchors ?? []) {
        if (!byId.has(anchor.source_asset_id)) {
          throw new RevisionError('invalid_command', 'A composition anchor references an unavailable source asset.');
        }
      }
      const clipById = new Map((scene.composition?.clips ?? []).map((clip) => [clip.id, clip]));
      for (const effect of scene.visual_effects ?? []) {
        const clip = clipById.get(effect.clip_instance_id);
        if (!clip || clip.source_asset_id !== effect.source_asset_id || effect.source_in_ms < clip.source_in_ms || effect.source_out_ms > clip.source_out_ms) {
          throw new RevisionError('invalid_command', 'A visual effect no longer matches its clip source interval.');
        }
        if (effect.type === 'logo' && assets.assets.find((asset) => asset.id === effect.asset_id)?.media_kind !== 'image') {
          throw new RevisionError('invalid_command', 'A logo effect requires an immutable image asset.');
        }
      }
      if (scene.transcript) {
        const source = byId.get(scene.transcript.source_asset_id);
        if (!source || source.checksum !== scene.transcript.source_sha256) throw new RevisionError('invalid_command', 'Transcript provenance no longer matches an immutable source asset.');
      }
      for (const lowerThird of scene.lower_thirds ?? []) {
        if (scene.recording?.duration_sec !== undefined && lowerThird.out_sec > scene.recording.duration_sec) {
          throw new RevisionError('invalid_command', 'A lower third extends beyond its scene recording.');
        }
      }
    }
  }

  async execute(input: ProjectCommandBatch): Promise<ProjectCommandResult> {
    const batch = ProjectCommandBatchSchema.parse(input);
    return this.serialize(async () => {
      const state = await this.readState();
      const payloadHash = hashPayload(batch);
      const prior = state.idempotency[batch.idempotencyKey];
      if (prior) {
        if (prior.payloadHash !== payloadHash) {
          throw new RevisionError('idempotency_conflict', 'This idempotency key was already used for a different request.', state.currentRevision);
        }
        return ProjectCommandResultSchema.parse(prior.result);
      }
      if (batch.expectedRevision !== state.currentRevision) {
        throw new RevisionError('stale_revision', 'The project changed since this request was prepared.', state.currentRevision);
      }

      const files = projectFiles(this.projectRoot);
      const documents = await this.readDocuments();
      const assets = await this.readAssets();
      const restore = batch.commands[0]?.type === 'revision.restore' ? batch.commands[0] : undefined;
      let next = restore
        ? await this.loadSnapshot(restore.revision)
        : { project: documents.project, storyboard: documents.storyboard };
      if (!restore) {
        for (const command of batch.commands) next = this.applyCommand(command, next, assets);
      }
      this.validateAssetReferences(next.storyboard, assets);

      const revision = state.currentRevision + 1;
      const revisionStatus = batch.targetState ?? 'draft';
      const result = ProjectCommandResultSchema.parse({
        projectId: next.project.id,
        revision,
        previousRevision: state.currentRevision,
        idempotencyKey: batch.idempotencyKey,
        applied: batch.commands.length,
        state: revisionStatus,
        restoredFrom: restore?.revision,
      });
      const revisionRecord = ProjectRevisionSchema.parse({
        revision,
        createdAt: new Date().toISOString(),
        idempotencyKey: batch.idempotencyKey,
        commandTypes: batch.commands.map((command) => command.type),
        state: revisionStatus,
        restoredFrom: restore?.revision,
      });
      const nextState: RevisionState = {
        ...state,
        currentRevision: revision,
        acceptedRevision: revisionStatus === 'accepted' ? revision : state.acceptedRevision,
        revisions: [...state.revisions, revisionRecord],
        idempotency: { ...state.idempotency, [batch.idempotencyKey]: { payloadHash, result } },
      };
      const nextProjectYaml = dumpYaml(next.project);
      const nextStoryboardYaml = next.storyboard ? dumpYaml(next.storyboard) : null;
      const journal: TransactionJournal = {
        version: 1,
        id: randomUUID(),
        targetRevision: revision,
        before: { projectYaml: documents.projectYaml, storyboardYaml: documents.storyboardYaml },
        after: { projectYaml: nextProjectYaml, storyboardYaml: nextStoryboardYaml },
      };
      await mkdir(files.revisionTransactionsDir, { recursive: true });
      const journalPath = path.join(files.revisionTransactionsDir, `${journal.id}.json`);
      await this.persist(journalPath, JSON.stringify(journal, null, 2));
      try {
        await this.persist(files.metadata, nextProjectYaml);
        if (nextStoryboardYaml !== null) await this.persist(files.storyboard, nextStoryboardYaml);
        await this.persist(path.join(files.revisionSnapshotsDir, snapshotName(revision)), JSON.stringify({
          version: 1,
          revision,
          project: next.project,
          storyboard: next.storyboard,
        } satisfies RevisionSnapshot, null, 2));
        await this.persist(files.revisionState, JSON.stringify(nextState, null, 2));
        await unlink(journalPath);
      } catch (error) {
        await this.recoverTransactions(state).catch(() => undefined);
        throw error;
      }
      return result;
    });
  }
}
