import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  CircleCheck,
  CircleX,
  Clipboard,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Square,
  Wrench,
  X,
} from 'lucide-react';
import type {
  AgentRecordingPlan,
  AgentRecordingPlanUpdate,
  AgentRecordingSession,
  CapSetupStatus,
} from '@vpa/shared';
import { agentRecordingApi, BASE, capSetupApi } from '../lib/api.js';

const TERMINAL_STATES = new Set(['completed', 'failed', 'interrupted']);
const TAKE_PHASES = ['Setup', 'Rehearse', 'Confirm', 'Record', 'Export', 'Attach'] as const;
const INSTALL_COPY = "VPA will download Cap Desktop from cap.so, install its command-line tool under VPA's local data folder, and leave your shell profile unchanged. macOS may ask you to approve the app and screen-recording permissions.";

interface AgentRecordingDialogProps {
  projectId: string;
  sceneId: string;
  open: boolean;
  onClose: () => void;
  onManualUpload: () => void;
}

export function AgentRecordingDialog({ projectId, sceneId, open, onClose, onManualUpload }: AgentRecordingDialogProps) {
  const queryClient = useQueryClient();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const installButtonRef = useRef<HTMLButtonElement>(null);
  const completedRef = useRef<string | null>(null);
  const [draft, setDraft] = useState<AgentRecordingPlanUpdate | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [showInstallConfirmation, setShowInstallConfirmation] = useState(false);

  const planQuery = useQuery({
    queryKey: agentRecordingApi.queryKey(projectId, sceneId),
    queryFn: () => agentRecordingApi.getPlan(projectId, sceneId),
    enabled: open,
  });
  const capQuery = useQuery({
    queryKey: capSetupApi.queryKey,
    queryFn: capSetupApi.status,
    enabled: open,
    refetchInterval: (query) => query.state.data?.state === 'installing' ? 2_000 : false,
  });
  const sessionQuery = useQuery({
    queryKey: agentRecordingApi.sessionQueryKey(projectId, sceneId),
    queryFn: () => agentRecordingApi.currentSession(projectId, sceneId),
    enabled: open,
    refetchInterval: (query) => query.state.data && !isTerminal(query.state.data) ? 1_500 : false,
  });

  useEffect(() => {
    if (planQuery.data) setDraft(editable(planQuery.data));
  }, [planQuery.data]);

  useEffect(() => {
    if (!open) {
      setShowInstallConfirmation(false);
      setCopied(false);
      setCopyError(null);
      return;
    }
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (showInstallConfirmation) setShowInstallConfirmation(false);
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open, showInstallConfirmation]);

  useEffect(() => {
    if (showInstallConfirmation) installButtonRef.current?.focus();
  }, [showInstallConfirmation]);

  const session = sessionQuery.data;
  const activeSession = Boolean(session && !isTerminal(session));

  const rehearse = useMutation({
    mutationFn: (value: AgentRecordingPlanUpdate) => agentRecordingApi.rehearse(projectId, sceneId, value),
    onSuccess: (next) => {
      queryClient.setQueryData(agentRecordingApi.sessionQueryKey(projectId, sceneId), next);
      queryClient.invalidateQueries({ queryKey: agentRecordingApi.queryKey(projectId, sceneId) });
    },
  });
  const rehearseAgain = useMutation({
    mutationFn: async ({ current, value }: { current: AgentRecordingSession; value: AgentRecordingPlanUpdate }) => {
      await agentRecordingApi.cancel(projectId, sceneId, current.id);
      return agentRecordingApi.rehearse(projectId, sceneId, value);
    },
    onSuccess: (next) => {
      queryClient.setQueryData(agentRecordingApi.sessionQueryKey(projectId, sceneId), next);
      queryClient.invalidateQueries({ queryKey: agentRecordingApi.queryKey(projectId, sceneId) });
    },
  });
  const confirm = useMutation({
    mutationFn: ({ id, fingerprint }: { id: string; fingerprint: string }) => agentRecordingApi.confirm(projectId, sceneId, id, fingerprint),
    onSuccess: (next) => queryClient.setQueryData(agentRecordingApi.sessionQueryKey(projectId, sceneId), next),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => agentRecordingApi.cancel(projectId, sceneId, id),
    onSuccess: (next) => queryClient.setQueryData(agentRecordingApi.sessionQueryKey(projectId, sceneId), next),
  });
  const checkCap = useMutation({
    mutationFn: capSetupApi.check,
    onSuccess: (next) => queryClient.setQueryData(capSetupApi.queryKey, next),
  });
  const installCap = useMutation({
    mutationFn: capSetupApi.install,
    onSuccess: (job) => {
      setShowInstallConfirmation(false);
      queryClient.setQueryData<CapSetupStatus>(capSetupApi.queryKey, (current) => ({
        ...(current ?? {
          installed: false,
          captureReady: false,
          missingPermissions: [],
          targetCount: 0,
        }),
        state: 'installing',
        installed: false,
        captureReady: false,
        installationId: job.installationId,
        message: 'Downloading and verifying Cap Desktop…',
        updatedAt: new Date().toISOString(),
      }));
    },
  });

  useEffect(() => {
    if (!open || session?.state !== 'completed' || completedRef.current === session.id) return;
    completedRef.current = session.id;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['workflow-status', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['recording-metadata', projectId, sceneId] }),
      queryClient.invalidateQueries({ queryKey: ['scene-recording', projectId, sceneId] }),
      queryClient.invalidateQueries({ queryKey: agentRecordingApi.sessionQueryKey(projectId, sceneId) }),
    ]).then(onClose);
  }, [open, onClose, projectId, queryClient, sceneId, session?.id, session?.state]);

  if (!open) return null;

  const cap = capQuery.data;
  const capReady = cap?.state === 'ready' && cap.captureReady;
  const unsupported = planQuery.data?.sceneType === 'terminal' || /^(terminal|chatgpt|cap|vpa|system settings)$/i.test(draft?.capture.targetApplication.trim() ?? '');
  const editsDisabled = activeSession || rehearse.isPending || rehearseAgain.isPending;
  const busy = rehearse.isPending || rehearseAgain.isPending || confirm.isPending || cancel.isPending;
  const error = firstError(rehearse.error, rehearseAgain.error, confirm.error, cancel.error, sessionQuery.error, checkCap.error, installCap.error);
  const canRehearse = Boolean(draft && capReady && !activeSession && !unsupported && draft.capture.targetApplication.trim());

  const copyInstructions = async () => {
    if (!draft) return;
    try {
      const plan = activeSession && planQuery.data
        ? planQuery.data
        : await agentRecordingApi.savePlan(projectId, sceneId, draft);
      queryClient.setQueryData(agentRecordingApi.queryKey(projectId, sceneId), plan);
      const planUrl = `${BASE}/api/projects/${projectId}/scenes/${sceneId}/agent-recording/plan`;
      await navigator.clipboard.writeText([
        'Use $vpa-agent-recording in this repository.',
        `Fetch and follow this reviewed plan exactly: ${planUrl}`,
        `Project: ${plan.projectId}`,
        `Scene: ${plan.sceneId}`,
        'Rehearse first. Do not begin recording until you show me the target and capture settings and I explicitly confirm.',
      ].join('\n'));
      setCopied(true);
      setCopyError(null);
    } catch (copyFailure) {
      setCopyError(copyFailure instanceof Error ? copyFailure.message : 'Could not copy the instructions.');
    }
  };

  return <div className="agent-recording-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="agent-recording-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-recording-title" aria-busy={busy}>
      <header>
        <div><span>Cap + Codex</span><h2 id="agent-recording-title">Capture this scene</h2></div>
        <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </header>

      <div className="agent-recording-dialog__body">
        <CapSetupPanel
          status={cap}
          targetApplication={draft?.capture.targetApplication ?? ''}
          loading={capQuery.isLoading}
          error={capQuery.error}
          checking={checkCap.isPending}
          onInstall={() => setShowInstallConfirmation(true)}
          onCheck={() => checkCap.mutate()}
          onManualUpload={onManualUpload}
        />
        <TakeRail capReady={capReady} session={session} />

        {planQuery.error ? <p className="agent-recording-warning" role="alert">{planQuery.error.message}</p> : planQuery.isLoading || !draft ? <div className="agent-recording-loading"><LoaderCircle className="spin" size={17} />Preparing the scene plan…</div> : <>
          {planQuery.data?.stale && <p className="agent-recording-notice">The scene changed after this plan was saved. Review it before rehearsing again.</p>}

          {(rehearse.isPending || rehearseAgain.isPending || session?.state === 'rehearsing') && <RehearsalProgress session={session} saving={rehearse.isPending || rehearseAgain.isPending} />}
          {session?.state === 'awaiting_confirmation' && session.rehearsal && <ConfirmationEvidence plan={planQuery.data} session={session} />}
          {session && session.state !== 'awaiting_confirmation' && session.state !== 'rehearsing' && <SessionPanel session={session} />}

          <section className="agent-recording-editor" aria-labelledby="capture-settings-title">
            <div className="agent-recording-section-heading">
              <div><span>Scene plan</span><h3 id="capture-settings-title">Target and capture settings</h3></div>
              {editsDisabled && <small><ShieldCheck size={13} />Locked to this take</small>}
            </div>
            <fieldset disabled={editsDisabled}>
              <div className="agent-recording-grid">
                <label>Target application<input value={draft.capture.targetApplication} placeholder="Safari, Chrome, Figma…" onChange={(event) => setDraft({ ...draft, capture: { ...draft.capture, targetApplication: event.target.value } })} /></label>
                <label>Starting URL<input type="url" value={draft.capture.startingUrl} placeholder="https://…" onChange={(event) => setDraft({ ...draft, capture: { ...draft.capture, startingUrl: event.target.value } })} /></label>
                <label>Capture target<select value={draft.capture.targetKind} onChange={(event) => setDraft({ ...draft, capture: { ...draft.capture, targetKind: event.target.value as 'window' | 'screen' } })}><option value="window">Application window</option><option value="screen">Entire screen</option></select></label>
                <label>Frame rate<select value={draft.capture.fps} onChange={(event) => setDraft({ ...draft, capture: { ...draft.capture, fps: Number(event.target.value) } })}><option value="30">30 fps</option><option value="60">60 fps</option></select></label>
                <label>Output width<input type="number" min="1" value={draft.capture.width} onChange={(event) => setDraft({ ...draft, capture: { ...draft.capture, width: Number(event.target.value) } })} /></label>
                <label>Output height<input type="number" min="1" value={draft.capture.height} onChange={(event) => setDraft({ ...draft, capture: { ...draft.capture, height: Number(event.target.value) } })} /></label>
              </div>
              <div className="agent-recording-toggles" role="group" aria-label="Capture sources">
                {(['cursor', 'microphone', 'camera', 'systemAudio'] as const).map((key) => <label className="agent-recording-check" key={key}><input type="checkbox" checked={draft.capture[key]} onChange={(event) => setDraft({ ...draft, capture: { ...draft.capture, [key]: event.target.checked } })} />{label(key)}</label>)}
              </div>
              <div className="agent-recording-plan"><h3>Actions</h3>{draft.steps.map((step, index) => <label key={step.index}><span>{index + 1}</span><input aria-label={`Action ${index + 1}`} value={step.action} onChange={(event) => setDraft({ ...draft, steps: draft.steps.map((item, itemIndex) => itemIndex === index ? { ...item, action: event.target.value } : item) })} /></label>)}</div>
            </fieldset>
          </section>

          <div className="agent-recording-readiness"><h3>Before the take</h3>{draft.preconditions.map((item) => <p key={item}><Check size={13} />{item}</p>)}<p><Check size={13} />VPA rehearses and resets the target before capture.</p></div>
          {unsupported && <p className="agent-recording-warning">This application cannot be controlled for a recording. Choose a supported browser or desktop application, or upload a take manually.</p>}
          {error && <p className="agent-recording-warning" role="alert">{error}</p>}
          {copyError && <p className="agent-recording-warning" role="alert">{copyError}</p>}

          <details className="agent-recording-troubleshooting">
            <summary><Wrench size={13} />Troubleshooting</summary>
            <p>If direct rehearsal cannot launch Codex, copy the reviewed handoff and run it in an authenticated Codex session.</p>
            <button type="button" onClick={copyInstructions} disabled={!draft}><Clipboard size={14} />{copied ? 'Instructions copied' : 'Copy instructions'}</button>
          </details>
        </>}
      </div>

      <footer>
        <button type="button" onClick={onManualUpload}>Upload manually</button>
        <div className="agent-recording-actions">
          {activeSession && <button type="button" className="btn--danger" disabled={cancel.isPending} onClick={() => session && cancel.mutate(session.id)}><Square size={13} />{cancel.isPending ? 'Stopping…' : 'Stop'}</button>}
          {session?.state === 'awaiting_confirmation' && <>
            <button type="button" disabled={rehearseAgain.isPending || !draft} onClick={() => draft && rehearseAgain.mutate({ current: session, value: draft })}><RefreshCw size={13} />Rehearse again</button>
            <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate(session.id)}>Cancel</button>
            <button type="button" className="primary" disabled={confirm.isPending || !session.planFingerprint} onClick={() => session.planFingerprint && confirm.mutate({ id: session.id, fingerprint: session.planFingerprint })}><ShieldCheck size={14} />{confirm.isPending ? 'Starting…' : 'Confirm & record'}</button>
          </>}
          {!activeSession && session?.state !== 'completed' && <button type="button" className="primary" disabled={!canRehearse || busy} onClick={() => draft && rehearse.mutate(draft)}>{busy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{session && isTerminal(session) ? 'Rehearse a new take' : 'Save & rehearse with Codex'}</button>}
        </div>
      </footer>

      {showInstallConfirmation && <div className="agent-recording-sheet-backdrop" role="presentation">
        <section className="agent-recording-sheet" role="alertdialog" aria-modal="true" aria-labelledby="install-cap-title" aria-describedby="install-cap-description">
          <div className="agent-recording-sheet__icon"><ShieldCheck size={20} /></div>
          <h3 id="install-cap-title">Install Cap Desktop?</h3>
          <p id="install-cap-description">{INSTALL_COPY}</p>
          <p className="agent-recording-sheet__detail">Cap Desktop may be placed in /Applications or your Applications folder. VPA keeps its CLI shim in VPA's own local data.</p>
          <div className="agent-recording-sheet__actions"><button type="button" onClick={() => setShowInstallConfirmation(false)}>Not now</button><button ref={installButtonRef} type="button" className="primary" disabled={installCap.isPending} onClick={() => installCap.mutate()}>{installCap.isPending ? 'Starting installation…' : 'Download and install Cap'}</button></div>
        </section>
      </div>}
    </section>
  </div>;
}

function CapSetupPanel({ status, targetApplication, loading, error, checking, onInstall, onCheck, onManualUpload }: {
  status?: CapSetupStatus;
  targetApplication: string;
  loading: boolean;
  error: Error | null;
  checking: boolean;
  onInstall: () => void;
  onCheck: () => void;
  onManualUpload: () => void;
}) {
  if (loading) return <section className="agent-recording-setup" aria-live="polite"><LoaderCircle className="spin" size={17} /><div><strong>Checking Cap</strong><span>Looking for the VPA-managed recording tool…</span></div></section>;
  if (error || !status) return <section className="agent-recording-setup agent-recording-setup--error" role="alert"><CircleX size={17} /><div><strong>Cap status is unavailable</strong><span>{error?.message ?? 'VPA could not read Cap setup.'}</span></div><button type="button" onClick={onCheck}>Retry check</button><button type="button" onClick={onManualUpload}>Upload manually</button></section>;

  if (status.state === 'not-installed') return <section className="agent-recording-setup"><AlertTriangle size={17} /><div><strong>Cap is not installed</strong><span>VPA can download Cap Desktop from cap.so and keep its command-line tool in VPA's local data folder.</span></div><button type="button" className="primary" onClick={onInstall}>Install Cap</button></section>;
  if (status.state === 'installing') return <section className="agent-recording-setup" aria-live="polite"><LoaderCircle className="spin" size={17} /><div><strong>Installing Cap</strong><span>{status.message ?? 'Downloading, installing, and verifying the local recorder…'}</span></div></section>;
  if (status.state === 'needs-permission') {
    const missing = status.missingPermissions.map(permissionLabel).join(' and ') || 'screen recording permission';
    const settingsUrl = status.missingPermissions.includes('accessibility')
      ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
      : 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
    return <section className="agent-recording-setup agent-recording-setup--attention"><AlertTriangle size={17} /><div><strong>Cap needs permission</strong><span>Allow {missing} in macOS, then retry the check.</span></div><a className="agent-recording-button-link" href={settingsUrl}>Open System Settings <ExternalLink size={12} /></a><button type="button" disabled={checking} onClick={onCheck}>{checking ? 'Checking…' : 'Retry check'}</button></section>;
  }
  if (status.state === 'error') return <section className="agent-recording-setup agent-recording-setup--error" role="alert"><CircleX size={17} /><div><strong>Problem detected</strong><span>{status.message ?? 'Cap is installed, but VPA could not verify that it is ready.'}</span></div><button type="button" disabled={checking} onClick={onCheck}>{checking ? 'Checking…' : 'Retry check'}</button><button type="button" onClick={onManualUpload}>Upload manually</button></section>;

  return <section className="agent-recording-setup agent-recording-setup--ready"><CircleCheck size={17} /><div><strong>Cap {status.version ?? ''} is ready</strong><span>Target: {targetApplication || 'Choose an application below'} · {status.targetCount} capture target{status.targetCount === 1 ? '' : 's'} available</span></div><span className="agent-recording-setup__ready"><ShieldCheck size={12} />Capture ready</span></section>;
}

function TakeRail({ capReady, session }: { capReady: boolean; session: AgentRecordingSession | null | undefined }) {
  const current = takePhaseIndex(capReady, session);
  const allDone = session?.state === 'completed';
  const failed = session?.state === 'failed' || session?.state === 'interrupted';
  return <ol className="agent-recording-take-rail" aria-label="Recording progress">
    {TAKE_PHASES.map((phase, index) => {
      const done = allDone || index < current;
      const active = !allDone && index === current;
      return <li key={phase} className={`${done ? 'is-done' : ''} ${active ? 'is-active' : ''} ${active && failed ? 'is-failed' : ''}`} aria-current={active ? 'step' : undefined}><span>{done ? <Check size={11} /> : index + 1}</span><small>{phase}</small></li>;
    })}
  </ol>;
}

function RehearsalProgress({ session, saving }: { session?: AgentRecordingSession | null; saving: boolean }) {
  const ready = session?.state === 'awaiting_confirmation';
  const rehearsing = session?.phase === 'rehearsing';
  const items = [
    { label: 'Checking Cap', done: rehearsing || ready, active: !saving && !rehearsing && !ready },
    { label: 'Checking permissions', done: rehearsing || ready, active: false },
    { label: 'Launching Codex', done: rehearsing || ready, active: false },
    { label: 'Rehearsing actions', done: ready, active: rehearsing },
    { label: 'Verifying reset', done: ready, active: false },
  ];
  return <section className="agent-recording-progress" aria-live="polite">
    <div className="agent-recording-section-heading"><div><span>Rehearsal</span><h3>{saving ? 'Saving the scene plan' : 'Codex is rehearsing'}</h3></div><LoaderCircle className="spin" size={17} /></div>
    <ol>{items.map((item) => <li key={item.label} className={item.done ? 'is-done' : item.active ? 'is-active' : ''}>{item.done ? <Check size={12} /> : item.active ? <LoaderCircle className="spin" size={12} /> : <span />}{item.label}</li>)}</ol>
    <p>{session?.message ?? 'VPA is preparing the reviewed target. Capture stays off during rehearsal.'}</p>
  </section>;
}

function ConfirmationEvidence({ plan, session }: { plan?: AgentRecordingPlan; session: AgentRecordingSession }) {
  const evidence = session.rehearsal;
  if (!plan || !evidence) return null;
  return <section className="agent-recording-evidence" aria-labelledby="recording-confirmation-title">
    <div className="agent-recording-section-heading"><div><span>Verified rehearsal</span><h3 id="recording-confirmation-title">Ready for your recording confirmation</h3></div><ShieldCheck size={18} /></div>
    <p className="agent-recording-capture-off"><span />Capture is still off. Recording begins only after you confirm this exact rehearsal.</p>
    <dl className="agent-recording-specs">
      <div><dt>Application</dt><dd>{evidence.targetApplication}</dd></div>
      <div><dt>Window</dt><dd>{evidence.windowTitle}</dd></div>
      <div><dt>Actual bounds</dt><dd><code>{evidence.windowBounds.width} × {evidence.windowBounds.height} at {evidence.windowBounds.x}, {evidence.windowBounds.y}</code></dd></div>
      <div><dt>Output</dt><dd><code>{plan.capture.width} × {plan.capture.height} · {plan.capture.fps} fps</code></dd></div>
    </dl>
    <div className="agent-recording-source-summary">{(['cursor', 'microphone', 'camera', 'systemAudio'] as const).map((key) => <span key={key} className={plan.capture[key] ? 'is-on' : ''}>{label(key)} {plan.capture[key] ? 'on' : 'off'}</span>)}</div>
    <div className="agent-recording-evidence-grid">
      <div><h4>Actions</h4><ol>{plan.steps.map((step) => { const passed = evidence.completedStepIndexes.includes(step.index); return <li key={step.index} className={passed ? 'is-passed' : 'is-failed'}>{passed ? <Check size={12} /> : <X size={12} />}<span>{step.action}</span></li>; })}</ol></div>
      <div><h4>Checkpoints</h4><ul>{evidence.checkpoints.map((checkpoint, index) => <li key={`${checkpoint.description}-${index}`} className={checkpoint.passed ? 'is-passed' : 'is-failed'}>{checkpoint.passed ? <Check size={12} /> : <X size={12} />}<span>{checkpoint.description}{checkpoint.detail && <small>{checkpoint.detail}</small>}</span></li>)}</ul></div>
    </div>
    <p className={`agent-recording-reset ${evidence.resetConfirmed ? 'is-passed' : 'is-failed'}`}>{evidence.resetConfirmed ? <CircleCheck size={14} /> : <CircleX size={14} />}Target reset {evidence.resetConfirmed ? 'verified' : 'not verified'}</p>
    {evidence.diagnostic && <p className="agent-recording-evidence__diagnostic">{evidence.diagnostic}</p>}
    <div className="agent-recording-fingerprint"><span>Rehearsed plan fingerprint</span><code>{session.planFingerprint}</code></div>
  </section>;
}

function SessionPanel({ session }: { session: AgentRecordingSession }) {
  const failed = session.state === 'failed' || session.state === 'interrupted';
  const done = session.state === 'completed';
  return <section className={`agent-recording-session-panel ${failed ? 'is-failed' : done ? 'is-done' : ''}`} aria-live="polite">
    {failed ? <CircleX size={18} /> : done ? <CircleCheck size={18} /> : <LoaderCircle className="spin" size={18} />}
    <div><strong>{statusLabel(session.state)}</strong><span>{session.message ?? activePhaseCopy(session.phase)}</span><small>Take {session.id.slice(0, 8)}</small></div>
  </section>;
}

function editable(plan: AgentRecordingPlan): AgentRecordingPlanUpdate {
  return { capture: plan.capture, steps: plan.steps, preconditions: plan.preconditions, checkpoints: plan.checkpoints, rehearseFirst: true, leadInSec: plan.leadInSec, tailSec: plan.tailSec };
}

function isTerminal(session: AgentRecordingSession): boolean { return TERMINAL_STATES.has(session.state); }

function takePhaseIndex(capReady: boolean, session?: AgentRecordingSession | null): number {
  if (!capReady) return 0;
  if (!session) return 1;
  if (session.state === 'rehearsing') return 1;
  if (session.state === 'awaiting_confirmation') return 2;
  if (session.state === 'recording') return 3;
  if (session.state === 'exporting') return 4;
  if (session.state === 'attaching' || session.state === 'completed') return 5;
  if (session.phase?.includes('export')) return 4;
  if (session.phase?.includes('attach')) return 5;
  return session.confirmedCapture ? 3 : 1;
}

function statusLabel(state: AgentRecordingSession['state']): string {
  const labels: Record<AgentRecordingSession['state'], string> = {
    rehearsing: 'Codex is rehearsing',
    awaiting_confirmation: 'Ready for your recording confirmation',
    recording: 'Recording this scene with Cap',
    exporting: 'Validating and exporting the take',
    attaching: 'Attaching the recording',
    completed: 'Recording attached',
    failed: 'Recording stopped',
    interrupted: 'Recording interrupted',
  };
  return labels[state];
}

function activePhaseCopy(phase?: string): string {
  const copy: Record<string, string> = {
    'starting-recording': 'Starting the confirmed Cap recording.',
    recording: 'Codex is performing the rehearsed actions.',
    'stopping-recording': 'Stopping the exact Cap take.',
    validating: 'Checking the local Cap project.',
    exporting: 'Exporting the verified take locally.',
    attaching: 'Adding the recording to this scene.',
    'verifying-attachment': 'Checking the scene attachment.',
  };
  return phase && copy[phase] ? copy[phase] : 'VPA is working on this take.';
}

function permissionLabel(permission: CapSetupStatus['missingPermissions'][number]): string {
  return permission === 'screen-recording' ? 'Screen Recording' : 'Accessibility';
}

function firstError(...errors: Array<Error | null>): string | null {
  const error = errors.find(Boolean);
  return error?.message ?? null;
}

function label(value: string): string { return value.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase()); }
