import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { brandsApi, jobsApi } from '../lib/api';
import { BrandSourceList } from '../components/BrandSourceList';
import { BrandReviewForm } from '../components/BrandReviewForm';
import { BrandPreviewPane } from '../components/BrandPreviewPane';
import type { DesignMdFrontMatter } from '@vpa/shared';

type Step = 'identify' | 'sources' | 'extracting' | 'review' | 'generating' | 'done';

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
  const [progress, setProgress] = useState<string[]>([]);
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
        setProgress((prev) => [...prev, `[${type}] ${event.data ? JSON.stringify(event.data) : ''}`]);

        if (type === 'tokens-ready' && event.data) {
          const d = event.data as { front_matter?: DesignMdFrontMatter; body?: string };
          if (d.front_matter) {
            onTokensReady(d.front_matter, d.body ?? '');
          }
        }
        if (type === 'done') {
          onDone?.();
        }
        if (type === 'error') {
          setError(event.data ? String((event.data as { message?: string }).message ?? event.data) : 'Job failed');
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
      setProgress([]);
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
      setProgress([]);
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
            Sources (at least one)
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
              className="primary"
              disabled={!canSubmit || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? 'Creating...' : 'Extract Brand Tokens'}
            </button>
          </div>
        </>
      )}

      {/* Step: extracting */}
      {step === 'extracting' && (
        <>
          <p>Extracting brand tokens from your sources...</p>
          <ul className="progress">
            {progress.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
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
          <p>Generating design.md...</p>
          <ul className="progress">
            {progress.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
