import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { z } from 'zod';
import {
  PresentationJobSchema,
  PresentationManifestSchema,
  SceneSchema,
  type PresentationJob,
  type PresentationManifest,
  type PresentationPageRecord,
  type Project,
  type Scene,
  type Storyboard,
} from '@vpa/shared';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import { sha256File } from '../recording/metadata.js';
import { projectFiles } from '../project/paths.js';
import { createStoryboard, loadStoryboard, mutateStoryboard } from '../storyboard/index.js';
import { PresentationJobStore } from './job-store.js';
import { createSlideAssets } from './media.js';
import { inspectPdf, PresentationPdfError } from './pdf.js';

const MAX_TEXT_CHARS_PER_PAGE = 20_000;
const IMAGE_ONLY_DESCRIPTION = 'Presentation slide awaiting visual analysis.';
const JobIdSchema = z.string().uuid();
const lifecycleTails = new Map<string, Promise<void>>();

export interface RegisterPresentationUploadInput {
  project: Project;
  id: string;
  filename: string;
  stagedSourcePath: string;
  sizeBytes: number;
  generateNarration: boolean;
}

export type PresentationImportErrorCode =
  | 'invalid_source'
  | 'source_not_available'
  | 'processing_failed'
  | 'storyboard_commit_failed'
  | 'committed_state_pending'
  | 'invalid_import_state'
  | 'interrupted_import'
  | 'encrypted_pdf'
  | 'invalid_pdf'
  | 'page_limit_exceeded';

export class PresentationImportError extends Error {
  constructor(readonly code: PresentationImportErrorCode, message: string) {
    super(message);
    this.name = 'PresentationImportError';
  }
}

class PresentationImportStateError extends PresentationImportError {
  constructor(readonly historyRollbackSafe: boolean) {
    super('invalid_import_state', 'Presentation import cannot be processed');
  }
}

type MutateStoryboard = typeof mutateStoryboard;

export type RetryPresentationNarration = (
  project: Project,
  presentationId: string,
) => Promise<PresentationJob>;

export interface PresentationImportServiceOptions {
  jobs: PresentationJobStore;
  maxPages: number;
  warn: (fields: Record<string, unknown>, message: string) => void;
  inspectPdf?: typeof inspectPdf;
  createSlideAssets?: typeof createSlideAssets;
  mutateStoryboard?: MutateStoryboard;
  persist?: typeof atomicWriteFile;
  hashFile?: typeof sha256File;
  copySource?: typeof copyFile;
  moveFiles?: typeof rename;
  removeFiles?: typeof rm;
  createId?: typeof randomUUID;
  now?: () => string;
}

function requireId(id: string): string {
  if (!JobIdSchema.safeParse(id).success) {
    throw new PresentationImportError('invalid_source', 'Invalid presentation source');
  }
  return id;
}

function displayName(filename: string): string {
  const normalized = filename.replaceAll('\\', '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1).trim();
  return (basename || 'Presentation.pdf').slice(0, 255);
}

function pageStem(pageNumber: number): string {
  return `page-${String(pageNumber).padStart(4, '0')}`;
}

function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(name) ? name : 'UnknownError';
}

function sceneMatchesManifestPage(
  scene: Scene | undefined,
  manifest: PresentationManifest,
  page: PresentationPageRecord,
): boolean {
  return scene?.presentation_source?.presentation_id === manifest.id
    && scene.presentation_source.page_number === page.page_number
    && scene.presentation_source.page_count === manifest.page_count
    && scene.presentation_source.image === page.image
    && scene.recording?.source_kind === 'presentation'
    && scene.recording.source === page.clip;
}

function publicPdfMessage(code: PresentationImportErrorCode): string {
  if (code === 'encrypted_pdf') return 'Password-protected PDFs are not supported';
  if (code === 'page_limit_exceeded') return 'The PDF has too many pages';
  return 'The file is not a valid PDF';
}

async function serializePresentationLifecycle<T>(
  projectPath: string,
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${path.resolve(projectPath)}\0${requireId(id)}`;
  const previous = lifecycleTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  lifecycleTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (lifecycleTails.get(key) === tail) lifecycleTails.delete(key);
  }
}

export class PresentationImportService {
  private readonly inspect: typeof inspectPdf;
  private readonly createAssets: typeof createSlideAssets;
  private readonly mutate: MutateStoryboard;
  private readonly persist: typeof atomicWriteFile;
  private readonly hash: typeof sha256File;
  private readonly copy: typeof copyFile;
  private readonly move: typeof rename;
  private readonly removeFiles: typeof rm;
  private readonly createId: typeof randomUUID;
  private readonly now: () => string;

  constructor(private readonly options: PresentationImportServiceOptions) {
    this.inspect = options.inspectPdf ?? inspectPdf;
    this.createAssets = options.createSlideAssets ?? createSlideAssets;
    this.mutate = options.mutateStoryboard ?? mutateStoryboard;
    this.persist = options.persist ?? atomicWriteFile;
    this.hash = options.hashFile ?? sha256File;
    this.copy = options.copySource ?? copyFile;
    this.move = options.moveFiles ?? rename;
    this.removeFiles = options.removeFiles ?? rm;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private paths(projectPath: string, id: string) {
    const validId = requireId(id);
    const files = projectFiles(projectPath);
    const stagingRoot = path.join(files.presentationStagingDir, validId);
    return {
      stagingRoot,
      source: path.join(stagingRoot, 'source.pdf'),
      final: path.join(files.presentationsDir, validId),
    };
  }

  private async failJob(
    projectPath: string,
    id: string,
    code: PresentationImportErrorCode,
    message: string,
    pageCount: number,
  ): Promise<void> {
    try {
      await this.options.jobs.update(projectPath, id, {
        status: 'failed',
        stage: 'failed',
        page_count: pageCount,
        error: { code, message },
      });
    } catch {
      // Preserve the bounded import failure even if job persistence also fails.
    }
  }

  private warn(fields: Record<string, unknown>, message: string): void {
    try {
      this.options.warn(fields, message);
    } catch {
      // Diagnostics are private and must not change behavior.
    }
  }

  private async validateCompleteBundle(
    projectPath: string,
    bundle: string,
    presentationId: string,
    location: 'staged' | 'final',
  ): Promise<PresentationManifest> {
    const invalid = () => new PresentationImportError(
      'invalid_import_state',
      'Presentation import cannot be processed',
    );
    try {
      const bundleInfo = await lstat(bundle);
      if (!bundleInfo.isDirectory() || bundleInfo.isSymbolicLink()) throw invalid();
      const canonicalBundle = await realpath(bundle);
      if (location === 'final') {
        const presentationsRoot = projectFiles(projectPath).presentationsDir;
        const rootInfo = await lstat(presentationsRoot);
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw invalid();
        const canonicalRoot = await realpath(presentationsRoot);
        if (canonicalBundle !== path.join(canonicalRoot, presentationId)) throw invalid();
      }

      const requireOwnedFile = async (relative: string): Promise<string> => {
        const lexical = path.join(bundle, relative);
        const info = await lstat(lexical);
        if (!info.isFile() || info.isSymbolicLink()) throw invalid();
        const canonical = await realpath(lexical);
        const expected = path.join(canonicalBundle, relative);
        if (canonical !== expected || !canonical.startsWith(`${canonicalBundle}${path.sep}`)) {
          throw invalid();
        }
        return canonical;
      };

      const manifestPath = await requireOwnedFile('manifest.json');
      const manifest = PresentationManifestSchema.parse(
        JSON.parse(await readFile(manifestPath, 'utf8')),
      );
      if (manifest.id !== presentationId) throw invalid();
      const prefix = `presentations/${presentationId}/`;
      const ownedRelatives = [
        'source.pdf',
        ...manifest.pages.flatMap((page) => [page.image, page.clip].map((relative) => {
          if (!relative.startsWith(prefix)) throw invalid();
          const ownedRelative = relative.slice(prefix.length);
          if (ownedRelative.length === 0) throw invalid();
          return ownedRelative;
        })),
      ];
      for (const relative of ownedRelatives) await requireOwnedFile(relative);
      return manifest;
    } catch (error) {
      if (error instanceof PresentationImportError) throw error;
      throw invalid();
    }
  }

  async registerUpload(input: RegisterPresentationUploadInput): Promise<PresentationJob> {
    const paths = this.paths(input.project.path, input.id);
    if (path.resolve(input.stagedSourcePath) !== path.resolve(paths.source)
      || !Number.isSafeInteger(input.sizeBytes)
      || input.sizeBytes <= 0) {
      throw new PresentationImportError('invalid_source', 'Invalid presentation source');
    }
    await this.hash(paths.source);
    const now = this.now();
    const job = PresentationJobSchema.parse({
      schema_version: 1,
      id: input.id,
      project_id: input.project.id,
      filename: displayName(input.filename),
      status: 'processing',
      stage: 'processing-slides',
      generate_narration: input.generateNarration,
      page_count: 0,
      processed_pages: 0,
      analyzed_pages: 0,
      scripted_pages: 0,
      remaining_scene_count: 0,
      deterministic_commit: 'uncommitted',
      created_at: now,
      updated_at: now,
    });
    return this.options.jobs.create(input.project.path, job);
  }

  async process(project: Project, id: string): Promise<PresentationJob> {
    return serializePresentationLifecycle(project.path, id, () => this.processUnlocked(project, id));
  }

  private async processUnlocked(project: Project, id: string): Promise<PresentationJob> {
    const job = await this.options.jobs.read(project.path, id);
    if (!job
      || job.project_id !== project.id
      || job.status !== 'processing'
      || job.stage !== 'processing-slides') {
      throw new PresentationImportStateError(true);
    }
    const paths = this.paths(project.path, id);
    const taskRoot = path.join(paths.stagingRoot, `task-${this.createId()}`);
    const bundle = path.join(taskRoot, 'bundle');
    const rawPages = path.join(taskRoot, 'raw-pages');
    let pageCount = 0;
    let finalMoved = false;
    let storyboardCommitted = false;
    let inspection: Awaited<ReturnType<typeof inspectPdf>> | undefined;

    await this.options.jobs.update(project.path, id, {
      status: 'processing',
      stage: 'processing-slides',
      page_count: 0,
      processed_pages: 0,
      analyzed_pages: 0,
      scripted_pages: 0,
      remaining_scene_count: 0,
      error: undefined,
    });

    try {
      inspection = await this.inspect(paths.source, {
        maxPages: this.options.maxPages,
        maxTextCharsPerPage: MAX_TEXT_CHARS_PER_PAGE,
      });
      pageCount = inspection.pageCount;
      if (pageCount < 1 || inspection.pages.length !== pageCount) {
        throw new PresentationPdfError('invalid_pdf', 'The file is not a valid PDF');
      }

      await mkdir(bundle, { recursive: true });
      await this.copy(paths.source, path.join(bundle, 'source.pdf'));
      const proposedPages: PresentationPageRecord[] = [];
      const proposedScenes: Scene[] = [];
      const proposedIds = new Set<string>();

      for (const page of inspection.pages) {
        const stem = pageStem(page.pageNumber);
        const rawPagePath = path.join(rawPages, `${stem}.png`);
        const imagePath = path.join(bundle, 'pages', `${stem}.png`);
        const clipPath = path.join(bundle, 'clips', `${stem}.mp4`);
        await page.render(rawPagePath);
        await this.createAssets({ rawPagePath, imagePath, clipPath });

        let sceneId: string;
        do sceneId = `scene-${this.createId().slice(0, 8)}`;
        while (proposedIds.has(sceneId));
        proposedIds.add(sceneId);

        const heading = page.heading?.trim();
        const name = heading && heading.length <= 200 ? heading : `Slide ${page.pageNumber}`;
        const extractedText = page.text.slice(0, MAX_TEXT_CHARS_PER_PAGE);
        const description = extractedText.trim().slice(0, 4_000) || IMAGE_ONLY_DESCRIPTION;
        const image = `presentations/${id}/pages/${stem}.png`;
        const clip = `presentations/${id}/clips/${stem}.mp4`;
        proposedScenes.push(SceneSchema.parse({
          id: sceneId,
          name,
          description,
          type: 'slide',
          recording: { source: clip, source_kind: 'presentation', duration_sec: 1 },
          presentation_source: {
            presentation_id: id,
            page_number: page.pageNumber,
            page_count: pageCount,
            image,
            hold_duration_sec: 5,
          },
        }));
        proposedPages.push({
          page_number: page.pageNumber,
          scene_id: sceneId,
          image,
          clip,
          extracted_text: extractedText,
          baseline: { name, description, narration_script: null },
          analysis_status: job.generate_narration ? 'pending' : 'not-requested',
          script_status: job.generate_narration ? 'pending' : 'not-requested',
        });
        await this.options.jobs.update(project.path, id, {
          page_count: pageCount,
          processed_pages: page.pageNumber,
        });
      }
      await inspection.close();
      inspection = undefined;

      const sourceHash = await this.hash(paths.source);
      const sourceSize = (await stat(paths.source)).size;
      const provisionalManifest = PresentationManifestSchema.parse({
        schema_version: 1,
        id,
        project_id: project.id,
        display_name: job.filename,
        source_sha256: sourceHash,
        size_bytes: sourceSize,
        page_count: pageCount,
        created_at: job.created_at,
        updated_at: this.now(),
        generate_narration: job.generate_narration,
        pages: proposedPages,
      });

      await this.options.jobs.update(project.path, id, {
        stage: 'creating-scenes',
        deterministic_commit: 'commit-pending',
      });
      let finalManifest: PresentationManifest | undefined;
      await this.mutate(project.path, async (current) => {
        const base = current ?? createStoryboard(project, []);
        if (base.scenes.some((scene) => scene.presentation_source?.presentation_id === id)) {
          throw new PresentationImportError('invalid_import_state', 'Presentation import cannot be processed');
        }

        const occupied = new Set(base.scenes.map(({ id: sceneId }) => sceneId));
        const scenes = proposedScenes.map((scene, index) => {
          let sceneId = scene.id;
          while (occupied.has(sceneId)) sceneId = `scene-${this.createId().slice(0, 8)}`;
          occupied.add(sceneId);
          proposedPages[index] = { ...proposedPages[index]!, scene_id: sceneId };
          return SceneSchema.parse({ ...scene, id: sceneId });
        });
        finalManifest = PresentationManifestSchema.parse({
          ...provisionalManifest,
          updated_at: this.now(),
          pages: proposedPages,
        });
        await this.persist(path.join(bundle, 'manifest.json'), JSON.stringify(finalManifest, null, 2));
        try {
          finalManifest = await this.validateCompleteBundle(project.path, bundle, id, 'staged');
        } catch {
          throw new Error('Incomplete staged presentation bundle');
        }
        const currentJob = await this.options.jobs.read(project.path, id);
        if (!currentJob
          || currentJob.project_id !== project.id
          || currentJob.status !== 'processing'
          || currentJob.stage !== 'creating-scenes'
          || currentJob.page_count !== pageCount
          || currentJob.processed_pages !== pageCount) {
          throw new PresentationImportError('invalid_import_state', 'Presentation import cannot be processed');
        }
        await this.removeFiles(paths.final, { recursive: true, force: true });
        await mkdir(path.dirname(paths.final), { recursive: true });
        await this.move(bundle, paths.final);
        finalMoved = true;
        return { ...base, scenes: [...base.scenes, ...scenes] } satisfies Storyboard;
      });
      storyboardCommitted = true;

      if (!finalManifest) throw new Error('Manifest was not created');
      const terminalJob = await this.options.jobs.update(project.path, id, {
        status: job.generate_narration ? 'processing' : 'ready',
        stage: job.generate_narration ? 'drafting-narration' : 'ready',
        page_count: pageCount,
        processed_pages: pageCount,
        remaining_scene_count: pageCount,
        deterministic_commit: 'committed',
        error: undefined,
      });
      try {
        finalManifest = PresentationManifestSchema.parse({ ...finalManifest, updated_at: this.now() });
        await this.persist(
          path.join(paths.final, 'manifest.json'),
          JSON.stringify(finalManifest, null, 2),
        );
      } catch {
        this.warn(
          { errorName: 'PresentationManifestRefreshError', presentationId: id },
          'Presentation manifest refresh failed after scene commit',
        );
      }
      try {
        await this.removeFiles(paths.stagingRoot, { recursive: true, force: true });
      } catch {
        this.warn(
          { errorName: 'PresentationStagingCleanupError', presentationId: id },
          'Presentation staging files could not be fully removed',
        );
      }
      return terminalJob;
    } catch (error) {
      if (storyboardCommitted) {
        this.warn(
          { errorName: 'PresentationCommittedStatePending', presentationId: id },
          'Presentation scenes committed before terminal status persistence',
        );
        throw new PresentationImportError(
          'committed_state_pending',
          'Presentation scenes were saved; status reconciliation is pending',
        );
      }
      if (inspection) await inspection.close().catch(() => undefined);
      await this.removeFiles(taskRoot, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof PresentationPdfError) {
        await this.removeFiles(paths.stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        const code = error.code;
        const message = publicPdfMessage(code);
        await this.failJob(project.path, id, code, message, pageCount);
        throw new PresentationImportError(code, message);
      }
      if (error instanceof PresentationImportError && error.code === 'invalid_import_state') {
        throw new PresentationImportStateError(!finalMoved);
      }
      const code = finalMoved && !storyboardCommitted ? 'storyboard_commit_failed' : 'processing_failed';
      const message = finalMoved && !storyboardCommitted
        ? 'Presentation scenes could not be saved'
        : 'Presentation processing failed';
      await this.failJob(project.path, id, code, message, pageCount);
      throw new PresentationImportError(code, message);
    }
  }

  async retryImport(project: Project, id: string): Promise<PresentationJob> {
    return serializePresentationLifecycle(project.path, id, () => this.retryImportUnlocked(project, id));
  }

  private async retryImportUnlocked(project: Project, id: string): Promise<PresentationJob> {
    const job = await this.options.jobs.read(project.path, id);
    if (!job || job.project_id !== project.id || job.status !== 'failed') {
      throw new PresentationImportError('source_not_available', 'The original PDF is not available for retry');
    }
    const paths = this.paths(project.path, id);
    let inspection: Awaited<ReturnType<typeof inspectPdf>> | undefined;
    try {
      inspection = await this.inspect(paths.source, {
        maxPages: this.options.maxPages,
        maxTextCharsPerPage: MAX_TEXT_CHARS_PER_PAGE,
      });
      if (inspection.pageCount < 1) throw new Error('empty PDF');
      await inspection.close();
    } catch {
      await inspection?.close().catch(() => undefined);
      await this.removeFiles(paths.stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      const message = 'The original PDF is not available for retry';
      await this.failJob(project.path, id, 'source_not_available', message, job.page_count);
      throw new PresentationImportError('source_not_available', message);
    }
    await this.options.jobs.update(project.path, id, {
      status: 'processing',
      stage: 'processing-slides',
      error: undefined,
    });
    try {
      return await this.processUnlocked(project, id);
    } catch (error) {
      if (error instanceof PresentationImportStateError && error.historyRollbackSafe) {
        try {
          await this.options.jobs.update(project.path, id, {
            status: 'failed',
            stage: 'failed',
            page_count: job.page_count,
            deterministic_commit: job.deterministic_commit,
            error: {
              code: 'invalid_import_state',
              message: 'Presentation import cannot be processed',
            },
          });
        } catch (persistenceError) {
          this.warn({
            errorName: safeErrorName(persistenceError),
            projectId: project.id,
            presentationId: id,
          }, 'Presentation retry rollback could not be persisted');
          throw new PresentationImportError('processing_failed', 'Presentation processing failed');
        }
      }
      throw error;
    }
  }

  private async withExactRemainingCounts(
    projectPath: string,
    jobs: PresentationJob[],
  ): Promise<PresentationJob[]> {
    const storyboard = await loadStoryboard(projectPath);
    const counts = new Map<string, number>();
    for (const scene of storyboard?.scenes ?? []) {
      const presentationId = scene.presentation_source?.presentation_id;
      if (presentationId) counts.set(presentationId, (counts.get(presentationId) ?? 0) + 1);
    }
    return jobs.map((job) => ({ ...job, remaining_scene_count: counts.get(job.id) ?? 0 }));
  }

  async list(projectPath: string): Promise<PresentationJob[]> {
    const publicJobs = (await this.options.jobs.list(projectPath)).filter((job) => !job.deletion_pending);
    return this.withExactRemainingCounts(projectPath, publicJobs);
  }

  async get(projectPath: string, id: string): Promise<PresentationJob | null> {
    const job = await this.options.jobs.read(projectPath, id);
    if (!job || job.deletion_pending) return null;
    return (await this.withExactRemainingCounts(projectPath, [job]))[0]!;
  }

  async remove(project: Project, id: string): Promise<void> {
    return serializePresentationLifecycle(project.path, id, () => this.removeUnlocked(project, id));
  }

  private async removeUnlocked(project: Project, id: string): Promise<void> {
    let job = await this.options.jobs.read(project.path, id);
    if (!job || job.id !== id || job.project_id !== project.id) {
      throw new PresentationImportError('invalid_import_state', 'Presentation import cannot be processed');
    }
    if (!job.deletion_pending) {
      job = await this.options.jobs.update(project.path, id, { deletion_pending: true });
    }
    const paths = this.paths(project.path, id);
    await this.mutate(project.path, (current) => {
      const base = current ?? createStoryboard(project, []);
      return {
        ...base,
        scenes: base.scenes.filter((scene) => scene.presentation_source?.presentation_id !== id),
      };
    });

    const deletionResults = await Promise.allSettled([
      this.removeFiles(paths.final, { recursive: true, force: true }),
      this.removeFiles(paths.stagingRoot, { recursive: true, force: true }),
    ]);
    if (deletionResults.some(({ status }) => status === 'rejected')) {
      this.warn(
        { errorName: 'PresentationAssetDeletionError', presentationId: id },
        'Presentation assets could not be fully removed',
      );
      return;
    }
    await this.options.jobs.delete(project.path, id);
  }

  private async reconcileJob(
    project: Project,
    id: string,
    retryNarration?: RetryPresentationNarration,
  ): Promise<void> {
    let job = await this.options.jobs.read(project.path, id);
    if (!job || job.project_id !== project.id) return;
    if (job.deletion_pending) {
      await this.removeUnlocked(project, id);
      return;
    }
    const storyboard = await loadStoryboard(project.path);

    if (job.status === 'processing' && job.stage === 'creating-scenes') {
      let manifest: PresentationManifest | undefined;
      try {
        const paths = this.paths(project.path, id);
        const candidate = await this.validateCompleteBundle(project.path, paths.final, id, 'final');
        if (candidate.project_id === project.id) manifest = candidate;
      } catch {
        // An incomplete or malformed final bundle is not proof of a commit.
      }

      if (manifest) {
        const scenesById = new Map((storyboard?.scenes ?? []).map((scene) => [scene.id, scene]));
        const fullyCommitted = manifest.pages.every((page) => (
          sceneMatchesManifestPage(scenesById.get(page.scene_id), manifest!, page)
        ));
        if (fullyCommitted) {
          const remainingSceneCount = (storyboard?.scenes ?? []).filter(
            (scene) => scene.presentation_source?.presentation_id === id,
          ).length;
          job = await this.options.jobs.update(project.path, id, {
            status: job.generate_narration ? 'processing' : 'ready',
            stage: job.generate_narration ? 'drafting-narration' : 'ready',
            page_count: manifest.page_count,
            processed_pages: manifest.page_count,
            remaining_scene_count: remainingSceneCount,
            deterministic_commit: 'committed',
            error: undefined,
          });
        }
      }
    }

    if (job.status === 'processing'
      && (job.stage === 'uploading'
        || job.stage === 'processing-slides'
        || job.stage === 'creating-scenes')) {
      job = await this.options.jobs.update(project.path, id, {
        status: 'failed',
        stage: 'failed',
        error: {
          code: 'interrupted_import',
          message: 'Presentation import was interrupted; retry the import',
        },
      });
    }

    if (job.status === 'processing' && job.stage === 'drafting-narration' && retryNarration) {
      await retryNarration(project, id);
    }
  }

  private async cleanupOrphanStaging(project: Project): Promise<void> {
    const stagingDirectory = projectFiles(project.path).presentationStagingDir;
    let entries: Dirent<string>[];
    try {
      entries = await readdir(stagingDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      if (!JobIdSchema.safeParse(id).success) {
        await this.removeFiles(path.join(stagingDirectory, entry.name), { recursive: true, force: true })
          .catch((error) => this.warn(
            { errorName: safeErrorName(error), projectId: project.id },
            'Presentation staging reconciliation failed',
          ));
        continue;
      }
      try {
        await serializePresentationLifecycle(project.path, id, async () => {
          if (!await this.options.jobs.read(project.path, id)) {
            await this.removeFiles(path.join(stagingDirectory, id), { recursive: true, force: true });
          }
        });
      } catch (error) {
        this.warn(
          { errorName: safeErrorName(error), projectId: project.id, presentationId: id },
          'Presentation staging reconciliation failed',
        );
      }
    }
  }

  private async cleanupUncommittedBundles(project: Project): Promise<void> {
    const presentationsDirectory = projectFiles(project.path).presentationsDir;
    let entries: Dirent<string>[];
    try {
      entries = await readdir(presentationsDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !JobIdSchema.safeParse(entry.name).success) continue;
      const id = entry.name;
      try {
        await serializePresentationLifecycle(project.path, id, async () => {
          const storyboard = await loadStoryboard(project.path);
          const job = await this.options.jobs.read(project.path, id);
          let manifest: PresentationManifest;
          try {
            manifest = await this.validateCompleteBundle(
              project.path,
              path.join(presentationsDirectory, id),
              id,
              'final',
            );
          } catch {
            // Without a validated manifest, reconciliation cannot prove asset ownership safely.
            return;
          }
          if (manifest.project_id !== project.id) return;

          const scenesById = new Map((storyboard?.scenes ?? []).map((scene) => [scene.id, scene]));
          const hasLiveManifestScene = manifest.pages.some((page) => scenesById.has(page.scene_id));
          if (hasLiveManifestScene || job?.deterministic_commit === 'committed') return;
          if (!job || job.deterministic_commit !== 'uncommitted') {
            this.warn({
              errorName: 'PresentationCommitHistoryUnknown',
              projectId: project.id,
              presentationId: id,
            }, 'Presentation bundle preserved because commit history is unknown');
            return;
          }
          await this.removeFiles(path.join(presentationsDirectory, id), { recursive: true, force: true });
        });
      } catch (error) {
        this.warn(
          { errorName: safeErrorName(error), projectId: project.id, presentationId: id },
          'Presentation bundle reconciliation failed',
        );
      }
    }
  }

  private async reconcileProject(
    project: Project,
    retryNarration?: RetryPresentationNarration,
  ): Promise<void> {
    // A malformed storyboard removes the evidence needed for safe commit recovery or cleanup.
    await loadStoryboard(project.path);
    const jobs = await this.options.jobs.list(project.path);
    for (const job of jobs) {
      try {
        await serializePresentationLifecycle(project.path, job.id, () => (
          this.reconcileJob(project, job.id, retryNarration)
        ));
      } catch (error) {
        this.warn(
          { errorName: safeErrorName(error), projectId: project.id, presentationId: job.id },
          'Presentation job reconciliation failed',
        );
      }
    }
    await this.cleanupOrphanStaging(project);
    await this.cleanupUncommittedBundles(project);
  }

  async reconcile(
    projects: Project[],
    retryNarration?: RetryPresentationNarration,
  ): Promise<void> {
    for (const project of projects) {
      try {
        await this.reconcileProject(project, retryNarration);
      } catch (error) {
        this.warn(
          { errorName: safeErrorName(error), projectId: project.id },
          'Presentation project reconciliation failed',
        );
      }
    }
  }
}
