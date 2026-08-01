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
import {
  hasSessionBoundConfirmationEvidence,
  isActiveAgentRecordingSession,
  shouldCloseAfterObservedCompletion,
} from '../lib/agent-recording-ui.js';

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
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const installButtonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const sheetOpenerRef = useRef<HTMLElement | null>(null);
  const observedActiveSessionRef = useRef<string | null>(null);
  const intentRef = useRef<string | null>(null);
  const [draft, setDraft] = useState<AgentRecordingPlanUpdate | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [showInstallConfirmation, setShowInstallConfirmation] = useState(false);
  const [activeIntent, setActiveIntent] = useState<string | null>(null);

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
    refetchInterval: (query) => isActiveAgentRecordingSession(query.state.data) ? 1_500 : false,
  });

  useEffect(() => {
    if (planQuery.data) setDraft(editable(planQuery.data));
  }, [planQuery.data]);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => closeButtonRef.current?.focus());
    const restoreOutside = backdropRef.current ? inertOutside(backdropRef.current) : () => {};
    return () => {
      cancelAnimationFrame(frame);
      restoreOutside();
      if (openerRef.current?.isConnected) openerRef.current.focus();
      openerRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setShowInstallConfirmation(false);
      setCopied(false);
      setCopyError(null);
      observedActiveSessionRef.current = null;
      intentRef.current = null;
      setActiveIntent(null);
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (activeIntent) return;
        if (showInstallConfirmation) setShowInstallConfirmation(false);
        else onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const scope = showInstallConfirmation ? sheetRef.current : dialogRef.current;
      if (!scope) return;
      trapTabKey(event, scope);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeIntent, onClose, open, showInstallConfirmation]);

  useEffect(() => {
    if (!showInstallConfirmation || !sheetRef.current) return;
    sheetOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreOutside = inertOutside(sheetRef.current);
    installButtonRef.current?.focus();
    return () => {
      restoreOutside();
      if (sheetOpenerRef.current?.isConnected) sheetOpenerRef.current.focus();
      else closeButtonRef.current?.focus();
      sheetOpenerRef.current = null;
    };
  }, [showInstallConfirmation]);

  useEffect(() => {
    observedActiveSessionRef.current = null;
  }, [projectId, sceneId]);

  const session = sessionQuery.data;
  const activeSession = isActiveAgentRecordingSession(session);

  useEffect(() => {
    if (open && session && isActiveAgentRecordingSession(session)) {
      observedActiveSessionRef.current = session.id;
    }
  }, [open, session]);

  const runExclusive = async (intent: string, operation: () => Promise<unknown>) => {
    if (intentRef.current) return;
    intentRef.current = intent;
    setActiveIntent(intent);
    try {
      await operation();
    } catch {
      // React Query mutations and the clipboard handler surface actionable errors in the dialog.
    } finally {
      intentRef.current = null;
      setActiveIntent(null);
    }
  };

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
    if (!open || !shouldCloseAfterObservedCompletion(observedActiveSessionRef.current, session)) return;
    observedActiveSessionRef.current = null;
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
  const capReady = cap?.state === 'ready' && cap.captureReady && cap.targetCount > 0;
  const unsupported = planQuery.data?.sceneType === 'terminal' || /^(terminal|chatgpt|cap|vpa|system settings)$/i.test(draft?.capture.targetApplication.trim() ?? '');
  const intentInFlight = activeIntent !== null;
  const editsDisabled = activeSession || intentInFlight;
  const manualUploadDisabled = activeSession || intentInFlight;
  const confirmationReady = hasSessionBoundConfirmationEvidence(session);
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

  const requestClose = () => { if (!intentRef.current) onClose(); };
  const requestManualUpload = () => {
    if (!intentRef.current && !activeSession) onManualUpload();
  };

  return <div ref={backdropRef} className="agent-recording-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
    <section ref={dialogRef} className="agent-recording-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-recording-title" aria-busy={intentInFlight} tabIndex={-1}>
      <header>
        <div><span>Cap + Codex</span><h2 id="agent-recording-title">Capture this scene</h2></div>
        <button ref={closeButtonRef} type="button" disabled={intentInFlight} onClick={requestClose} aria-label="Close"><X size={18} /></button>
      </header>

      <div className="agent-recording-dialog__body">
        <CapSetupPanel
          status={cap}
          targetApplication={draft?.capture.targetApplication ?? ''}
          loading={capQuery.isLoading}
          error={capQuery.error}
          checking={checkCap.isPending}
          onInstall={() => setShowInstallConfirmation(true)}
          onCheck={() => void runExclusive('check-cap', () => checkCap.mutateAsync())}
          onManualUpload={requestManualUpload}
          actionsDisabled={intentInFlight || activeSession}
          manualUploadDisabled={manualUploadDisabled}
        />
        <TakeRail capReady={capReady} session={session} />

        {planQuery.error ? <p className="agent-recording-warning" role="alert">{planQuery.error.message}</p> : planQuery.isLoading || !draft ? <div className="agent-recording-loading"><LoaderCircle className="spin" size={17} />Preparing the scene plan…</div> : <>
          {planQuery.data?.stale && <p className="agent-recording-notice">The scene changed after this plan was saved. Review it before rehearsing again.</p>}

          {(rehearse.isPending || rehearseAgain.isPending || session?.state === 'rehearsing') && <RehearsalProgress session={session} saving={rehearse.isPending || rehearseAgain.isPending} />}
          {session?.state === 'awaiting_confirmation' && session.rehearsal && <ConfirmationEvidence session={session} confirmable={confirmationReady} />}
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
            <button type="button" onClick={() => void runExclusive('copy', copyInstructions)} disabled={!draft || intentInFlight}><Clipboard size={14} />{activeIntent === 'copy' ? 'Copying…' : copied ? 'Instructions copied' : 'Copy instructions'}</button>
          </details>
        </>}
      </div>

      <footer>
        <div className="agent-recording-manual-action">
          <button type="button" disabled={manualUploadDisabled} aria-describedby={activeSession ? 'agent-recording-manual-blocked' : undefined} onClick={requestManualUpload}>Upload manually</button>
          {activeSession && <small id="agent-recording-manual-blocked">Stop this take before uploading a file.</small>}
        </div>
        <div className="agent-recording-actions">
          {activeSession && <button type="button" className="btn--danger" disabled={intentInFlight} onClick={() => session && void runExclusive('stop', () => cancel.mutateAsync(session.id))}><Square size={13} />{activeIntent === 'stop' ? 'Stopping…' : 'Stop'}</button>}
          {session?.state === 'awaiting_confirmation' && <>
            <button type="button" disabled={intentInFlight || !draft} onClick={() => draft && void runExclusive('rehearse-again', () => rehearseAgain.mutateAsync({ current: session, value: draft }))}><RefreshCw size={13} />{activeIntent === 'rehearse-again' ? 'Starting rehearsal…' : 'Rehearse again'}</button>
            <button type="button" disabled={intentInFlight} onClick={() => void runExclusive('cancel', () => cancel.mutateAsync(session.id))}>{activeIntent === 'cancel' ? 'Cancelling…' : 'Cancel'}</button>
            <button type="button" className="primary" disabled={intentInFlight || !confirmationReady || !session.planFingerprint} title={!confirmationReady ? 'Rehearse again to bind the reviewed settings to this confirmation.' : undefined} onClick={() => session.planFingerprint && void runExclusive('confirm', () => confirm.mutateAsync({ id: session.id, fingerprint: session.planFingerprint! }))}><ShieldCheck size={14} />{activeIntent === 'confirm' ? 'Starting…' : 'Confirm & record'}</button>
          </>}
          {!activeSession && <button type="button" className="primary" disabled={!canRehearse || intentInFlight} onClick={() => draft && void runExclusive('rehearse', () => rehearse.mutateAsync(draft))}>{activeIntent === 'rehearse' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{session?.state === 'completed' ? 'Record another take' : session ? 'Rehearse again' : 'Save & rehearse with Codex'}</button>}
        </div>
      </footer>

      {showInstallConfirmation && <div className="agent-recording-sheet-backdrop" role="presentation">
        <section ref={sheetRef} className="agent-recording-sheet" role="alertdialog" aria-modal="true" aria-labelledby="install-cap-title" aria-describedby="install-cap-description" tabIndex={-1}>
          <div className="agent-recording-sheet__icon"><ShieldCheck size={20} /></div>
          <h3 id="install-cap-title">Install Cap Desktop?</h3>
          <p id="install-cap-description">{INSTALL_COPY}</p>
          <p className="agent-recording-sheet__detail">Cap Desktop may be placed in /Applications or your Applications folder. VPA keeps its CLI shim in VPA's own local data.</p>
          <div className="agent-recording-sheet__actions"><button type="button" disabled={intentInFlight} onClick={() => setShowInstallConfirmation(false)}>Not now</button><button ref={installButtonRef} type="button" className="primary" disabled={intentInFlight} onClick={() => void runExclusive('install-cap', () => installCap.mutateAsync())}>{activeIntent === 'install-cap' ? 'Starting installation…' : 'Download and install Cap'}</button></div>
        </section>
      </div>}
    </section>
  </div>;
}

function CapSetupPanel({ status, targetApplication, loading, error, checking, onInstall, onCheck, onManualUpload, actionsDisabled, manualUploadDisabled }: {
  status?: CapSetupStatus;
  targetApplication: string;
  loading: boolean;
  error: Error | null;
  checking: boolean;
  onInstall: () => void;
  onCheck: () => void;
  onManualUpload: () => void;
  actionsDisabled: boolean;
  manualUploadDisabled: boolean;
}) {
  if (loading) return <section className="agent-recording-setup" aria-live="polite"><LoaderCircle className="spin" size={17} /><div><strong>Checking Cap</strong><span>Looking for the VPA-managed recording tool…</span></div></section>;
  if (error || !status) return <section className="agent-recording-setup agent-recording-setup--error" role="alert"><CircleX size={17} /><div><strong>Cap status is unavailable</strong><span>{error?.message ?? 'VPA could not read Cap setup.'}</span></div><button type="button" disabled={actionsDisabled} onClick={onCheck}>Retry check</button><button type="button" disabled={manualUploadDisabled} onClick={onManualUpload}>Upload manually</button></section>;

  if (status.state === 'not-installed') return <section className="agent-recording-setup"><AlertTriangle size={17} /><div><strong>Cap is not installed</strong><span>VPA can download Cap Desktop from cap.so and keep its command-line tool in VPA's local data folder.</span></div><button type="button" className="primary" disabled={actionsDisabled} onClick={onInstall}>Install Cap</button></section>;
  if (status.state === 'installing') return <section className="agent-recording-setup" aria-live="polite"><LoaderCircle className="spin" size={17} /><div><strong>Installing Cap</strong><span>{status.message ?? 'Downloading, installing, and verifying the local recorder…'}</span></div></section>;
  if (status.state === 'needs-permission') {
    const missing = status.missingPermissions.map(permissionLabel).join(' and ') || 'screen recording permission';
    const settingsUrl = status.missingPermissions.includes('accessibility')
      ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
      : 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
    return <section className="agent-recording-setup agent-recording-setup--attention"><AlertTriangle size={17} /><div><strong>Cap needs permission</strong><span>Allow {missing} in macOS, then retry the check.</span></div><a className="agent-recording-button-link" aria-disabled={actionsDisabled} tabIndex={actionsDisabled ? -1 : undefined} href={actionsDisabled ? undefined : settingsUrl}>Open System Settings <ExternalLink size={12} /></a><button type="button" disabled={actionsDisabled || checking} onClick={onCheck}>{checking ? 'Checking…' : 'Retry check'}</button></section>;
  }
  if (status.state === 'error') return <section className="agent-recording-setup agent-recording-setup--error" role="alert"><CircleX size={17} /><div><strong>Problem detected</strong><span>{status.message ?? 'Cap is installed, but VPA could not verify that it is ready.'}</span></div><button type="button" disabled={actionsDisabled || checking} onClick={onCheck}>{checking ? 'Checking…' : 'Retry check'}</button><button type="button" disabled={manualUploadDisabled} onClick={onManualUpload}>Upload manually</button></section>;

  if (!status.captureReady) return <section className="agent-recording-setup agent-recording-setup--attention"><AlertTriangle size={17} /><div><strong>Cap is not ready to capture</strong><span>Finish the macOS setup, then retry the check.</span></div><button type="button" disabled={actionsDisabled || checking} onClick={onCheck}>{checking ? 'Checking…' : 'Retry check'}</button></section>;
  if (status.targetCount === 0) return <section className="agent-recording-setup agent-recording-setup--attention"><AlertTriangle size={17} /><div><strong>No capture targets found</strong><span>Requested application: {targetApplication || 'Choose an application below'}. Open its window, then retry the check.</span></div><button type="button" disabled={actionsDisabled || checking} onClick={onCheck}>{checking ? 'Checking…' : 'Retry check'}</button></section>;

  return <section className="agent-recording-setup agent-recording-setup--ready"><CircleCheck size={17} /><div><strong>Cap {status.version ?? ''} is ready</strong><span>Requested application: {targetApplication || 'Choose an application below'} · {status.targetCount} capture target{status.targetCount === 1 ? '' : 's'} available</span></div><span className="agent-recording-setup__ready"><ShieldCheck size={12} />Cap checks passed</span></section>;
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
  const rehearsing = session?.phase === 'rehearsing';
  const checking = !saving && !rehearsing;
  const items = [
    { label: 'Checking Cap', done: rehearsing, active: checking },
    { label: 'Checking permissions', done: rehearsing, active: checking },
    { label: 'Launching Codex', done: false, active: rehearsing },
    { label: 'Rehearsing actions', done: false, active: rehearsing },
    { label: 'Verifying reset', done: false, active: false },
  ];
  return <section className="agent-recording-progress" aria-live="polite">
    <div className="agent-recording-section-heading"><div><span>Rehearsal</span><h3>{saving ? 'Saving the scene plan' : rehearsing ? 'Codex is rehearsing' : 'Checking Cap and permissions'}</h3></div><LoaderCircle className="spin" size={17} /></div>
    <ol>{items.map((item) => <li key={item.label} className={item.done ? 'is-done' : item.active ? 'is-active' : ''}>{item.done ? <Check size={12} /> : item.active ? <LoaderCircle className="spin" size={12} /> : <span />}{item.label}</li>)}</ol>
    <p>{session?.message ?? 'VPA reports a step as complete only after the coordinator verifies it. Capture stays off during rehearsal.'}</p>
  </section>;
}

function ConfirmationEvidence({ session, confirmable }: { session: AgentRecordingSession; confirmable: boolean }) {
  const evidence = session.rehearsal;
  if (!evidence) return null;
  const capture = evidence.reviewedCapture;
  const steps = evidence.reviewedSteps;
  return <section className="agent-recording-evidence" aria-labelledby="recording-confirmation-title">
    <div className="agent-recording-section-heading"><div><span>Verified rehearsal</span><h3 id="recording-confirmation-title">{confirmable ? 'Ready for your recording confirmation' : 'Rehearse again before recording'}</h3></div><ShieldCheck size={18} /></div>
    <p className="agent-recording-capture-off"><span />Capture is still off. Recording begins only after you confirm this exact rehearsal.</p>
    {!confirmable && <p className="agent-recording-notice" role="alert">The saved rehearsal does not contain every reviewed capture setting. Rehearse again before recording.</p>}
    <dl className="agent-recording-specs">
      <div><dt>Verified application</dt><dd>{evidence.targetApplication}</dd></div>
      <div><dt>Verified window</dt><dd>{evidence.windowTitle}</dd></div>
      <div><dt>Actual bounds</dt><dd><code>{evidence.windowBounds.width} × {evidence.windowBounds.height} at {evidence.windowBounds.x}, {evidence.windowBounds.y}</code></dd></div>
      <div><dt>Reviewed output</dt><dd>{capture ? <code>{capture.width} × {capture.height} · {capture.fps} fps</code> : 'Rehearsal required'}</dd></div>
    </dl>
    {capture && <div className="agent-recording-source-summary">{(['cursor', 'microphone', 'camera', 'systemAudio'] as const).map((key) => <span key={key} className={capture[key] ? 'is-on' : ''}>{label(key)} {capture[key] ? 'on' : 'off'}</span>)}</div>}
    <div className="agent-recording-evidence-grid">
      <div><h4>Reviewed actions</h4>{steps ? <ol>{steps.map((step) => { const passed = evidence.completedStepIndexes.includes(step.index); return <li key={step.index} className={passed ? 'is-passed' : 'is-failed'}>{passed ? <Check size={12} /> : <X size={12} />}<span>{step.action}</span></li>; })}</ol> : <p>Rehearse again to review the action list.</p>}</div>
      <div><h4>Checkpoints</h4><ul>{evidence.checkpoints.map((checkpoint, index) => <li key={`${checkpoint.description}-${index}`} className={checkpoint.passed ? 'is-passed' : 'is-failed'}>{checkpoint.passed ? <Check size={12} /> : <X size={12} />}<span>{checkpoint.description}{checkpoint.detail && <small>{checkpoint.detail}</small>}</span></li>)}</ul></div>
    </div>
    <p className={`agent-recording-reset ${evidence.resetConfirmed ? 'is-passed' : 'is-failed'}`}>{evidence.resetConfirmed ? <CircleCheck size={14} /> : <CircleX size={14} />}Target reset {evidence.resetConfirmed ? 'verified' : 'not verified'}</p>
    {evidence.diagnostic && <p className="agent-recording-evidence__diagnostic">{evidence.diagnostic}</p>}
    {confirmable && <p className="agent-recording-binding"><ShieldCheck size={13} />This confirmation is bound to the reviewed rehearsal.</p>}
  </section>;
}

function SessionPanel({ session }: { session: AgentRecordingSession }) {
  const failed = session.state === 'failed' || session.state === 'interrupted';
  const done = session.state === 'completed';
  return <section className={`agent-recording-session-panel ${failed ? 'is-failed' : done ? 'is-done' : ''}`} aria-live="polite">
    {failed ? <CircleX size={18} /> : done ? <CircleCheck size={18} /> : <LoaderCircle className="spin" size={18} />}
    <div><strong>{statusLabel(session.state)}</strong><span>{session.message ?? activePhaseCopy(session.phase)}</span></div>
  </section>;
}

function editable(plan: AgentRecordingPlan): AgentRecordingPlanUpdate {
  return { capture: plan.capture, steps: plan.steps, preconditions: plan.preconditions, checkpoints: plan.checkpoints, rehearseFirst: true, leadInSec: plan.leadInSec, tailSec: plan.tailSec };
}

function takePhaseIndex(capReady: boolean, session?: AgentRecordingSession | null): number {
  if (session) {
    if (session.state === 'rehearsing') return 1;
    if (session.state === 'awaiting_confirmation') return 2;
    if (session.state === 'recording') return 3;
    if (session.state === 'exporting') return 4;
    if (session.state === 'attaching' || session.state === 'completed') return 5;
    if (session.phase?.includes('export')) return 4;
    if (session.phase?.includes('attach')) return 5;
    if (session.confirmedCapture) return 3;
  }
  return capReady ? 1 : 0;
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

const FOCUSABLE_SELECTOR = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
  'textarea:not([disabled])', 'details > summary', '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.hidden || element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

function trapTabKey(event: KeyboardEvent, scope: HTMLElement): void {
  const elements = focusableElements(scope);
  if (elements.length === 0) {
    event.preventDefault();
    scope.focus();
    return;
  }
  const first = elements[0]!;
  const last = elements[elements.length - 1]!;
  const current = document.activeElement;
  if (event.shiftKey && (current === first || !scope.contains(current))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (current === last || !scope.contains(current))) {
    event.preventDefault();
    first.focus();
  }
}

function inertOutside(modal: HTMLElement): () => void {
  const changed: Array<{ element: HTMLElement; inert: boolean; ariaHidden: string | null }> = [];
  let branch: HTMLElement = modal;
  while (branch.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
      changed.push({ element: sibling, inert: sibling.inert, ariaHidden: sibling.getAttribute('aria-hidden') });
      sibling.inert = true;
      sibling.setAttribute('aria-hidden', 'true');
    }
    if (parent === document.body) break;
    branch = parent;
  }
  return () => {
    for (const previous of changed.reverse()) {
      previous.element.inert = previous.inert;
      if (previous.ariaHidden === null) previous.element.removeAttribute('aria-hidden');
      else previous.element.setAttribute('aria-hidden', previous.ariaHidden);
    }
  };
}
