import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { brandsApi, jobsApi } from '../lib/api';
import { BrandSourceList } from '../components/BrandSourceList';
import { BrandReviewForm } from '../components/BrandReviewForm';
import { BrandPreviewPane } from '../components/BrandPreviewPane';
import type { DesignMdFrontMatter } from '@vpa/shared';

type Step = 'identify' | 'sources' | 'extracting' | 'review' | 'generating' | 'done';

/* ── Pipeline progress component ────────────────────────────── */

interface PipelineStep {
  id: string;
  label: string;
  detail?: string;
}

type StepStatus = 'done' | 'active' | 'pending';

function PipelineProgress({
  steps,
  activeStepId,
  startTime,
}: {
  steps: PipelineStep[];
  activeStepId: string | null;
  startTime: number;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startTime) / 1000)), 1000);
    return () => clearInterval(t);
  }, [startTime]);

  const activeIdx = activeStepId ? steps.findIndex((s) => s.id === activeStepId) : -1;

  const getStatus = (idx: number): StepStatus => {
    if (activeIdx < 0) return idx === 0 ? 'active' : 'pending';
    if (idx < activeIdx) return 'done';
    if (idx === activeIdx) return 'active';
    return 'pending';
  };

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timeStr = mins > 0 ? `${mins}m ${secs.toString().padStart(2, '0')}s` : `${secs}s`;

  return (
    <div className="brand-generation-progress">
      {steps.map((step, i) => {
        const status = getStatus(i);
        return (
          <div key={step.id} className="brand-generation-progress__step">
            <div
              className={`brand-generation-progress__icon brand-generation-progress__icon--${status}`}
              aria-label={status}
            >
              {status === 'done' ? '✓' : ''}
            </div>
            <div className="brand-generation-progress__body">
              <div
                className={`brand-generation-progress__label${status === 'pending' ? ' brand-generation-progress__label--pending' : ''}`}
              >
                {step.label}
              </div>
              {step.detail && status !== 'pending' && (
                <div
                  className={`brand-generation-progress__detail${status === 'active' ? ' brand-generation-progress__detail--active' : ''}`}
                >
                  {step.detail}
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div className="brand-generation-progress__elapsed">
        Elapsed: <span>{timeStr}</span>
      </div>
    </div>
  );
}

/* ── Human-readable step mapping ────────────────────────────── */

const EXTRACT_STEPS: PipelineStep[] = [
  { id: 'persisted', label: 'Sources uploaded' },
  { id: 'extracting', label: 'Reading documents' },
  { id: 'extracting-tokens', label: 'Analyzing with AI', detail: 'This can take a minute with local models...' },
  { id: 'tokens-ready', label: 'Tokens extracted' },
];

const GENERATE_STEPS: PipelineStep[] = [
  { id: 'writing-rationale', label: 'Writing design rationale', detail: 'AI is composing your design.md...' },
  { id: 'done', label: 'Brand saved' },
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export default function BrandNew() {
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('identify');
  const [name, setName] = useState('');
  const [files, setFiles] = useState<{ file: File }[]>([]);
  const [urls, setUrls] = useState('');
  const [freeText, setFreeText] = useState('');
  const [pipelineStepId, setPipelineStepId] = useState<string | null>(null);
  const [pipelineStartTime, setPipelineStartTime] = useState(Date.now());
  const [frontMatter, setFrontMatter] = useState<DesignMdFrontMatter | null>(null);
  const [body, setBody] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState('');

  const closeRef = useRef<(() => void) | null>(null);

  // Clean up SSE on unmount
  useEffect(() => {
    return () => {
      closeRef.current?.();
    };
  }, []);

  const subscribeToJob = useCallback(
    (jobId: string, onTokensReady: (fm: DesignMdFrontMatter, b: string) => void, onDone?: () => void) => {
      closeRef.current?.();
      const close = jobsApi.stream(jobId, (event) => {
        const type = event.type;

        // Update pipeline position for any recognized step
        setPipelineStepId(type);

        // Enrich extracting step with the source filename
        if (type === 'extracting' && event.data) {
          const d = event.data as { source?: string };
          if (d.source) {
            const shortName = d.source.replace(/^\d+-/, '');
            EXTRACT_STEPS[1] = { id: 'extracting', label: 'Reading documents', detail: shortName };
          }
        }

        if (type === 'tokens-ready' && event.data) {
          const d = event.data as { frontMatter?: DesignMdFrontMatter; body?: string };
          if (d.frontMatter) {
            onTokensReady(d.frontMatter, d.body ?? '');
          }
        }
        if (type === 'done') {
          onDone?.();
        }
        if (type === 'error') {
          const errData = event.data as { error?: string } | undefined;
          setError(errData?.error ?? 'Job failed');
        }
      });
      closeRef.current = close;
    },
    [],
  );

  const createMutation = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append('name', name);
      if (urls.trim()) form.append('urls', urls.trim());
      if (freeText.trim()) form.append('free_text', freeText.trim());
      files.forEach((f) => form.append('files', f.file));
      return brandsApi.create(form);
    },
    onSuccess: (result) => {
      setSlug(result.slug);
      setStep('extracting');
      setPipelineStepId(null);
      setPipelineStartTime(Date.now());
      subscribeToJob(
        result.job_id,
        (fm, b) => {
          setFrontMatter(fm);
          setBody(b);
          setStep('review');
        },
      );
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Create failed'),
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      if (!frontMatter) throw new Error('No front matter');
      return brandsApi.generate(slug, frontMatter);
    },
    onSuccess: (result) => {
      setStep('generating');
      setPipelineStepId(null);
      setPipelineStartTime(Date.now());
      subscribeToJob(
        result.job_id,
        () => {},
        () => {
          setStep('done');
          navigate(`/brands/${slug}`);
        },
      );
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Generate failed'),
  });

  const manualMutation = useMutation({
    mutationFn: () => brandsApi.manual({ name: name.trim() }),
    onSuccess: (brand) => navigate(`/brands/${brand.registry.id}`),
    onError: (err) => setError(err instanceof Error ? err.message : 'Manual brand creation failed'),
  });

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files;
    if (!selected) return;
    const newFiles = Array.from(selected).map((file) => ({ file }));
    setFiles((prev) => [...prev, ...newFiles]);
    e.target.value = '';
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const canSubmit = name.trim().length > 0 && (files.length > 0 || urls.trim() || freeText.trim());

  const isReview = step === 'review';

  return (
    <main className={`brand-new${isReview ? ' brand-new--review' : ''}`}>
      <h1>New Brand</h1>

      {error && (
        <div style={{ color: 'var(--danger)', marginBottom: 12 }}>
          {error}
          <button
            type="button"
            style={{ marginLeft: 8 }}
            onClick={() => setError('')}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Step: identify + sources */}
      {(step === 'identify' || step === 'sources') && (
        <>
          <label className="label">Brand name</label>
          <input
            style={{ width: '100%' }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Corp"
          />
          {name && (
            <p className="hint">
              Slug: <code>{slugify(name)}</code>
            </p>
          )}

          <label className="label" style={{ marginTop: 20 }}>
            Sources for AI extraction (optional)
          </label>

          <label className="label">Upload files (PDF, MD, TXT)</label>
          <input
            type="file"
            accept=".pdf,.md,.txt"
            multiple
            onChange={handleFileInput}
          />
          <BrandSourceList files={files} onRemove={removeFile} />

          <label className="label">Website URLs (one per line)</label>
          <textarea
            rows={3}
            style={{ width: '100%' }}
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            placeholder="https://example.com/about"
          />

          <label className="label">Free text (brand guidelines, notes)</label>
          <textarea
            rows={4}
            style={{ width: '100%' }}
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="Paste brand guidelines text here..."
          />

          <div className="brand-new__actions">
            <button type="button" onClick={() => navigate('/')}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!name.trim() || manualMutation.isPending}
              onClick={() => manualMutation.mutate()}
            >
              {manualMutation.isPending ? 'Creating…' : 'Create manually'}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!canSubmit || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? 'Creating...' : 'Extract Brand Tokens'}
            </button>
          </div>
          <p className="hint">Manual creation uses a validated starter kit and makes no model call. You can edit every token on the next screen.</p>
        </>
      )}

      {/* Step: extracting */}
      {step === 'extracting' && (
        <>
          <p style={{ color: 'var(--fg-muted)', fontSize: 14 }}>
            Analyzing your sources and extracting brand tokens...
          </p>
          <PipelineProgress
            steps={EXTRACT_STEPS}
            activeStepId={pipelineStepId}
            startTime={pipelineStartTime}
          />
        </>
      )}

      {/* Step: review */}
      {step === 'review' && frontMatter && (
        <>
          <p className="hint">Review and adjust the extracted brand tokens, then generate your design.md</p>
          <div className="brand-new__panes">
            <BrandReviewForm value={frontMatter} onChange={setFrontMatter} />
            <BrandPreviewPane value={frontMatter} body={body} />
          </div>
          <div className="brand-new__actions">
            <button type="button" onClick={() => setStep('identify')}>
              Back
            </button>
            <button
              type="button"
              className="primary"
              disabled={generateMutation.isPending}
              onClick={() => generateMutation.mutate()}
            >
              {generateMutation.isPending ? 'Generating...' : 'Generate design.md'}
            </button>
          </div>
        </>
      )}

      {/* Step: generating */}
      {step === 'generating' && (
        <>
          <p style={{ color: 'var(--fg-muted)', fontSize: 14 }}>
            Generating your design.md file...
          </p>
          <PipelineProgress
            steps={GENERATE_STEPS}
            activeStepId={pipelineStepId}
            startTime={pipelineStartTime}
          />
        </>
      )}
    </main>
  );
}
