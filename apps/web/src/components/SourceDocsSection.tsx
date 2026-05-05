/**
 * Source-docs section on Project Overview. Lets users upload reference
 * documents (PDFs, markdown, plain text), add URLs, or paste raw text.
 * The extracted markdown is fed into every "creative" LLM call (ideation,
 * scene description, script writer, lower thirds, dialog conversion,
 * quality review) so generated copy is grounded in real product material.
 *
 * Surfaced inside Project Overview's collapsible "Output" group; also
 * embedded into the post-create flow on NewProjectDialog as a one-shot
 * dropzone.
 */

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sourceDocsApi, type SourceDoc } from '../lib/api.js';
import { useUi } from './ui/UiProvider.js';

interface Props {
  projectId: string;
}

export function SourceDocsSection({ projectId }: Props) {
  const qc = useQueryClient();
  const ui = useUi();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [urlText, setUrlText] = useState('');
  const [showText, setShowText] = useState(false);
  const [textBody, setTextBody] = useState('');
  const [textName, setTextName] = useState('');

  const docsQuery = useQuery({
    queryKey: ['source-docs', projectId],
    queryFn: () => sourceDocsApi.list(projectId),
  });
  const docs = docsQuery.data ?? [];
  const totalChars = docs.reduce((acc, d) => acc + d.extractedChars, 0);

  const uploadMutation = useMutation({
    mutationFn: (files: File[]) => sourceDocsApi.uploadFiles(projectId, files),
    onSuccess: ({ created }) => {
      qc.invalidateQueries({ queryKey: ['source-docs', projectId] });
      ui.showToast({
        message: `Added ${created.length} source doc${created.length === 1 ? '' : 's'}`,
        tone: 'success',
      });
    },
    onError: (err) => {
      ui.showToast({
        message: 'Upload failed',
        detail: err instanceof Error ? err.message : 'unknown error',
        tone: 'error',
      });
    },
  });

  const addUrlMutation = useMutation({
    mutationFn: (url: string) => sourceDocsApi.addUrl(projectId, url),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['source-docs', projectId] });
      setUrlText('');
      ui.showToast({ message: 'URL extracted and added', tone: 'success' });
    },
    onError: (err) => {
      ui.showToast({
        message: 'URL extraction failed',
        detail: err instanceof Error ? err.message : 'unknown error',
        tone: 'error',
      });
    },
  });

  const addTextMutation = useMutation({
    mutationFn: ({ text, name }: { text: string; name: string }) =>
      sourceDocsApi.addText(projectId, text, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['source-docs', projectId] });
      setTextBody('');
      setTextName('');
      setShowText(false);
      ui.showToast({ message: 'Note added', tone: 'success' });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (docId: string) => sourceDocsApi.remove(projectId, docId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['source-docs', projectId] });
    },
  });

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    uploadMutation.mutate(Array.from(list));
    e.target.value = ''; // allow re-selecting the same file
  };

  return (
    <div
      style={{
        marginTop: 32,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 20,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Source documents
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>
            {docs.length === 0
              ? 'None — drop in product docs to ground every AI-written line'
              : `${docs.length} doc${docs.length === 1 ? '' : 's'} · ${totalChars.toLocaleString()} chars`}
          </div>
          <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '6px 0 0', maxWidth: 600 }}>
            PDFs, markdown, plain text, or URLs. Used as reference context for ideation, scene
            description, script writing, lower-third recommendations, dialog conversion, and
            quality review. Big libraries are summarised at call time.
          </p>
        </div>
      </div>

      {/* Upload affordances */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.md,.markdown,.txt,.docx,.html,.htm,.yaml,.yml"
          style={{ display: 'none' }}
          onChange={onFileChange}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadMutation.isPending}
          className="primary"
          style={{ padding: '8px 16px', fontSize: 13 }}
        >
          {uploadMutation.isPending ? 'Extracting…' : '+ Upload files'}
        </button>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input
            type="url"
            value={urlText}
            onChange={(e) => setUrlText(e.target.value)}
            placeholder="https://… (URL to extract)"
            disabled={addUrlMutation.isPending}
            style={{
              padding: '7px 10px',
              fontSize: 13,
              background: 'var(--bg)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              minWidth: 260,
            }}
          />
          <button
            onClick={() => addUrlMutation.mutate(urlText.trim())}
            disabled={addUrlMutation.isPending || !urlText.trim()}
            style={{ padding: '7px 12px', fontSize: 13 }}
          >
            {addUrlMutation.isPending ? 'Extracting…' : 'Add URL'}
          </button>
        </div>
        <button
          onClick={() => setShowText((v) => !v)}
          style={{ padding: '7px 12px', fontSize: 13 }}
        >
          {showText ? '× Cancel note' : '+ Paste note'}
        </button>
      </div>

      {showText && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            type="text"
            value={textName}
            onChange={(e) => setTextName(e.target.value)}
            placeholder="Note name (e.g. 'Pricing tiers')"
            style={{
              padding: '8px 10px',
              fontSize: 13,
              background: 'var(--bg)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 6,
            }}
          />
          <textarea
            value={textBody}
            onChange={(e) => setTextBody(e.target.value)}
            rows={4}
            placeholder="Paste any text you want the AI to use as reference…"
            style={{
              padding: '8px 10px',
              fontSize: 13,
              background: 'var(--bg)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontFamily: 'inherit',
              resize: 'vertical',
            }}
          />
          <div>
            <button
              onClick={() => addTextMutation.mutate({ text: textBody.trim(), name: textName.trim() || 'note' })}
              disabled={addTextMutation.isPending || !textBody.trim()}
              className="primary"
              style={{ padding: '6px 14px', fontSize: 13 }}
            >
              {addTextMutation.isPending ? 'Saving…' : 'Save note'}
            </button>
          </div>
        </div>
      )}

      {/* List */}
      {docs.length > 0 && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {docs.map((d) => (
            <DocRow
              key={d.id}
              doc={d}
              onRemove={async () => {
                const ok = await ui.confirm({
                  title: 'Remove this reference doc?',
                  body: `"${d.name}" will no longer be used as AI context.`,
                  confirmLabel: 'Remove',
                  destructive: true,
                });
                if (ok) removeMutation.mutate(d.id);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DocRow({ doc, onRemove }: { doc: SourceDoc; onRemove: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 12px',
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 6,
      }}
    >
      <span aria-hidden style={{ fontSize: 16 }}>
        {doc.kind === 'url' ? '🔗' : doc.kind === 'text' ? '📝' : '📄'}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {doc.name}
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          {doc.extractor} · {doc.extractedChars.toLocaleString()} chars · {new Date(doc.uploadedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </div>
      </div>
      <button
        onClick={onRemove}
        style={{
          padding: '4px 10px',
          fontSize: 12,
          color: 'var(--danger)',
          background: 'transparent',
          border: '1px solid var(--danger)',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        Remove
      </button>
    </div>
  );
}
