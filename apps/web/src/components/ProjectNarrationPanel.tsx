import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Expressiveness, Scene } from '@vpa/shared';
import { jobsApi, narrationApi, ttsApi } from '../lib/api.js';
import {
  parseProjectNarrationResult,
  projectNarrationPreview,
  type ProjectNarrationTerminalResult,
} from '../lib/project-narration.js';

interface ProjectNarrationPanelProps {
  projectId: string;
  scenes: Scene[];
  expressiveness: Expressiveness;
  expressivenessPending: boolean;
  onExpressivenessChange: (value: Expressiveness) => void;
}

const TERMINAL_QUERY_KEYS = [
  'storyboard',
  'narration',
  'workflow-status',
  'active-jobs',
  'jobs',
  'render',
  'readiness',
];

export function ProjectNarrationPanel({
  projectId,
  scenes,
  expressiveness,
  expressivenessPending,
  onExpressivenessChange,
}: ProjectNarrationPanelProps) {
  const queryClient = useQueryClient();
  const [engineId, setEngineId] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [speed, setSpeed] = useState(1);
  const [overwrite, setOverwrite] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState('Ready');
  const [statusIsAlert, setStatusIsAlert] = useState(false);
  const [terminalResult, setTerminalResult] = useState<ProjectNarrationTerminalResult | null>(null);

  const { data: engines = [] } = useQuery({
    queryKey: ['tts-engines'],
    queryFn: ttsApi.listEngines,
  });
  const { data: activeJobs } = useQuery({
    queryKey: ['active-jobs', projectId],
    queryFn: () => jobsApi.list({ active: true, projectId }),
  });

  useEffect(() => {
    if (engines.length === 0) return;
    const current = engines.find((engine) => engine.id === engineId && engine.voices.length > 0);
    if (current) return;
    const preferred = engines.find((engine) => engine.id !== 'fake' && engine.voices.length > 0)
      ?? engines.find((engine) => engine.voices.length > 0);
    setEngineId(preferred?.id ?? '');
    setVoiceId(preferred?.voices[0]?.id ?? '');
  }, [engineId, engines]);

  useEffect(() => {
    const engine = engines.find((candidate) => candidate.id === engineId);
    if (!engine) return;
    if (!engine.voices.some((voice) => voice.id === voiceId)) {
      setVoiceId(engine.voices[0]?.id ?? '');
    }
  }, [engineId, engines, voiceId]);

  useEffect(() => {
    if (jobId) return;
    const recovered = activeJobs?.jobs.find((job) => job.type === 'narration-generate-project');
    if (recovered) {
      setJobId(recovered.id);
      setStatus('Project narration is running');
    }
  }, [activeJobs, jobId]);

  useEffect(() => {
    if (!jobId) return;
    return jobsApi.stream(jobId, (event) => {
      if (event.type === 'progress') {
        const progress = event.data as {
          processedScenes?: unknown;
          totalScenes?: unknown;
          sceneNumber?: unknown;
          sceneName?: unknown;
          generatedScenes?: unknown;
          preservedScenes?: unknown;
          noScriptScenes?: unknown;
          failedScenes?: unknown;
        };
        const position = typeof progress?.sceneNumber === 'number'
          ? progress.sceneNumber
          : (typeof progress?.processedScenes === 'number' ? progress.processedScenes : null);
        const total = typeof progress?.totalScenes === 'number' ? progress.totalScenes : null;
        const sceneName = typeof progress?.sceneName === 'string' ? progress.sceneName : '';
        const generated = typeof progress?.generatedScenes === 'number' ? progress.generatedScenes : 0;
        const preserved = typeof progress?.preservedScenes === 'number' ? progress.preservedScenes : 0;
        const skipped = typeof progress?.noScriptScenes === 'number' ? progress.noScriptScenes : 0;
        const failed = typeof progress?.failedScenes === 'number' ? progress.failedScenes : 0;
        setStatus(position !== null && total !== null
          ? `Narrating ${position} of ${total}${sceneName ? ` · ${sceneName}` : ''} · ${generated} generated · ${preserved} preserved · ${skipped} skipped · ${failed} failed`
          : 'Project narration is running');
      } else if (event.type === 'done') {
        const result = parseProjectNarrationResult(event.data);
        setTerminalResult(result);
        setStatusIsAlert(Boolean(result?.failedScenes));
        if (result?.cancelled) {
          setStatus('Narration cancelled');
        } else if (result?.failedScenes) {
          setStatus(`Narration finished · ${result.generatedScenes} generated · ${result.preservedScenes} preserved · ${result.noScriptScenes} skipped · ${result.failedScenes} failed`);
        } else if (result && result.generatedScenes === 0) {
          setStatus(`Nothing to generate · ${result.preservedScenes} preserved · ${result.noScriptScenes} skipped`);
        } else if (result) {
          setStatus(`Narration complete · ${result.generatedScenes} generated · ${result.preservedScenes} preserved · ${result.noScriptScenes} skipped`);
        } else {
          setStatus('Narration complete');
        }
        setJobId(null);
        for (const key of TERMINAL_QUERY_KEYS) {
          void queryClient.invalidateQueries({ queryKey: [key] });
        }
      } else if (event.type === 'cancel-requested') {
        setStatus('Cancellation requested · finishing the current audio chunk');
      } else if (event.type === 'cancel') {
        setStatus('Narration cancelled');
        setJobId(null);
        for (const key of TERMINAL_QUERY_KEYS) {
          void queryClient.invalidateQueries({ queryKey: [key] });
        }
      } else if (event.type === 'error') {
        setStatusIsAlert(true);
        setStatus('Project narration could not finish. Check your narration settings and try again.');
        setJobId(null);
        for (const key of TERMINAL_QUERY_KEYS) {
          void queryClient.invalidateQueries({ queryKey: [key] });
        }
      }
    });
  }, [jobId, queryClient]);

  const selectedEngine = engines.find((engine) => engine.id === engineId);
  const preview = useMemo(
    () => projectNarrationPreview(scenes, overwrite),
    [overwrite, scenes],
  );

  const start = useMutation({
    mutationFn: () => narrationApi.generateProject(projectId, {
      engine: engineId,
      voice: voiceId,
      speed,
      expressiveness,
      overwrite,
    }),
    onSuccess: (job) => {
      setTerminalResult(null);
      setStatusIsAlert(false);
      setJobId(job.jobId);
      setStatus('Project narration is starting');
      void queryClient.invalidateQueries({ queryKey: ['active-jobs', projectId] });
    },
    onError: () => {
      setStatusIsAlert(true);
      setStatus('Project narration could not start. Check your narration settings and try again.');
    },
  });
  const cancel = useMutation({
    mutationFn: () => narrationApi.cancelJob(jobId!),
    onSuccess: () => {
      setStatus('Cancellation requested · finishing the current audio chunk');
    },
    onError: () => setStatus('Cancellation could not be confirmed. Check the active job and try again.'),
  });

  const running = Boolean(jobId) || start.isPending;

  return (
    <section className="project-narration-panel" aria-labelledby="project-narration-title">
      <div className="project-narration-panel__header">
        <div>
          <span>Whole project</span>
          <h2 id="project-narration-title">Narrate all scripted scenes</h2>
          <p>Scenes without a script are skipped. Existing audio stays untouched unless you choose overwrite.</p>
        </div>
        <div className="project-narration-panel__preview" aria-label="Narration preview">
          <strong>{preview.willNarrateScenes}</strong> {preview.willNarrateScenes === 1 ? 'scene' : 'scenes'} will be narrated
          <small>{preview.preservedScenes} existing narration preserved · {preview.noScriptScenes} without scripts skipped</small>
        </div>
      </div>

      <div className="project-narration-panel__controls">
        <label>
          <span>Engine</span>
          <select
            aria-label="Narration engine"
            value={engineId}
            disabled={running}
            onChange={(event) => {
              const nextEngine = engines.find((engine) => engine.id === event.target.value);
              setEngineId(event.target.value);
              setVoiceId(nextEngine?.voices[0]?.id ?? '');
            }}
          >
            {engines.map((engine) => <option key={engine.id} value={engine.id}>{engine.displayName}</option>)}
          </select>
        </label>
        <label>
          <span>Voice</span>
          <select aria-label="Narration voice" value={voiceId} disabled={running} onChange={(event) => setVoiceId(event.target.value)}>
            {selectedEngine?.voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
          </select>
        </label>
        <label>
          <span>Speed</span>
          <input
            aria-label="Narration speed"
            type="number"
            min="0.5"
            max="2"
            step="0.05"
            value={speed}
            disabled={running}
            onChange={(event) => setSpeed(Math.min(2, Math.max(0.5, Number(event.target.value) || 1)))}
          />
        </label>
        <fieldset disabled={running || expressivenessPending}>
          <legend>Emotiveness</legend>
          <div className="project-narration-panel__segments">
            {(['light', 'medium', 'heavy'] as const).map((level) => (
              <button
                key={level}
                type="button"
                aria-pressed={expressiveness === level}
                onClick={() => onExpressivenessChange(level)}
              >
                {level}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="project-narration-panel__footer">
        <label className="project-narration-panel__overwrite">
          <input type="checkbox" checked={overwrite} disabled={running} onChange={(event) => setOverwrite(event.target.checked)} />
          <span><strong>Overwrite existing narration</strong><small>Regenerates audio for every scripted scene.</small></span>
        </label>
        <div className="project-narration-panel__actions">
          <span role={statusIsAlert ? 'alert' : 'status'} aria-live={statusIsAlert ? 'assertive' : 'polite'}>{status}</span>
          {jobId ? (
            <button type="button" className="btn-secondary" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancel</button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled={running || expressivenessPending || !engineId || !voiceId || preview.scriptedScenes === 0}
              onClick={() => start.mutate()}
            >
              Narrate project
            </button>
          )}
        </div>
      </div>
      {terminalResult && terminalResult.failures.length > 0 && (
        <ul className="project-narration-panel__failures" aria-label="Scenes that could not be narrated">
          {terminalResult.failures.map((failure) => <li key={failure.sceneId}>{failure.sceneName}</li>)}
        </ul>
      )}
    </section>
  );
}
