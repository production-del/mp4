'use client';

import { useState } from 'react';
import { parseUsageCSV } from '../utils/parseUsageCSV';

interface UsageImportModalProps {
  existingUsage: Record<string, number>;
  onImport: (usage: Record<string, number>) => void;
  onClose: () => void;
}

export function UsageImportModal({
  existingUsage,
  onImport,
  onClose,
}: UsageImportModalProps) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<{
    data: Record<string, number>;
    errors: string[];
  } | null>(null);

  const handleParse = () => {
    const result = parseUsageCSV(text);
    setPreview(result);
  };

  const handleImport = () => {
    if (preview && Object.keys(preview.data).length > 0) {
      onImport(preview.data);
      onClose();
    }
  };

  const previewEntries = preview ? Object.entries(preview.data) : [];
  const existingCount = Object.keys(existingUsage).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      {/* Modal */}
      <div
        className="relative rounded w-[600px] max-h-[80vh] flex flex-col"
        style={{ background: 'var(--bg-page)', border: '0.5px solid var(--border)' }}
      >
        <div
          className="px-6 py-4 flex items-center justify-between"
          style={{ borderBottom: '0.5px solid var(--border)' }}
        >
          <div>
            <h2 className="text-[22px]" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
              Import Monthly Usage
            </h2>
            <p className="text-base mt-1" style={{ color: 'var(--text-muted)' }}>
              Paste CSV/TSV data: SKU, usage per month
              {existingCount > 0 && ` · ${existingCount} SKUs already have usage data`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-2xl transition hover:opacity-70"
            style={{ color: 'var(--text-muted)' }}
          >
            ✕
          </button>
        </div>

        <div className="p-6 flex-1 overflow-y-auto space-y-4">
          {/* Text input */}
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(null);
            }}
            placeholder={`MFWALNUME,1560\nMFWALNULG,820\nMFMIXENSM,3200`}
            rows={8}
            className="w-full px-3 py-2 rounded text-lg font-mono resize-y transition focus:outline-none"
            style={{
              color: 'var(--text-primary)',
              background: 'var(--bg-surface)',
              border: '0.5px solid var(--border)',
            }}
          />

          {!preview && (
            <button
              onClick={handleParse}
              disabled={!text.trim()}
              className="px-4 py-2 rounded text-lg transition hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                fontWeight: 500,
                color: '#fff',
                background: 'var(--accent)',
              }}
            >
              Preview
            </button>
          )}

          {/* Preview */}
          {preview && (
            <div className="space-y-3">
              {preview.errors.length > 0 && (
                <div
                  className="rounded p-3"
                  style={{ background: 'var(--danger-light)', border: '0.5px solid var(--danger)' }}
                >
                  <div className="text-base mb-1" style={{ fontWeight: 500, color: 'var(--danger)' }}>Parse Errors</div>
                  {preview.errors.map((err, i) => (
                    <div key={i} className="text-base" style={{ color: 'var(--danger)' }}>{err}</div>
                  ))}
                </div>
              )}

              {previewEntries.length > 0 && (
                <div
                  className="rounded overflow-hidden"
                  style={{ border: '0.5px solid var(--border)' }}
                >
                  <div
                    className="px-3 py-2"
                    style={{ background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)' }}
                  >
                    <span className="text-base" style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>
                      {previewEntries.length} SKU{previewEntries.length !== 1 ? 's' : ''} to import
                    </span>
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    <table className="w-full text-base">
                      <thead>
                        <tr style={{ color: 'var(--text-muted)' }}>
                          <th className="px-3 py-1.5 text-left" style={{ fontWeight: 500 }}>SKU</th>
                          <th className="px-3 py-1.5 text-right" style={{ fontWeight: 500 }}>Usage/mo</th>
                          <th className="px-3 py-1.5 text-right" style={{ fontWeight: 500 }}>Current</th>
                        </tr>
                      </thead>
                      <tbody>
                        {previewEntries.slice(0, 50).map(([sku, usage]) => (
                          <tr key={sku} style={{ borderTop: '0.5px solid var(--border)' }}>
                            <td className="px-3 py-1 font-mono" style={{ color: 'var(--text-primary)' }}>{sku}</td>
                            <td className="px-3 py-1 text-right" style={{ color: 'var(--accent)', fontWeight: 500 }}>{usage}</td>
                            <td className="px-3 py-1 text-right" style={{ color: 'var(--text-muted)' }}>
                              {existingUsage[sku] ?? '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {previewEntries.length > 50 && (
                      <div className="px-3 py-1.5 text-base text-center" style={{ color: 'var(--text-muted)' }}>
                        + {previewEntries.length - 50} more...
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {preview && previewEntries.length > 0 && (
          <div
            className="px-6 py-4 flex items-center justify-end gap-3"
            style={{ borderTop: '0.5px solid var(--border)' }}
          >
            <button
              onClick={() => setPreview(null)}
              className="px-4 py-2 rounded text-lg transition hover:opacity-80"
              style={{
                color: 'var(--text-secondary)',
                background: 'var(--bg-surface)',
                border: '0.5px solid var(--border)',
              }}
            >
              Back
            </button>
            <button
              onClick={handleImport}
              className="px-4 py-2 rounded text-lg transition hover:opacity-90"
              style={{
                fontWeight: 500,
                color: '#fff',
                background: 'var(--success)',
              }}
            >
              Import {previewEntries.length} SKU{previewEntries.length !== 1 ? 's' : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
