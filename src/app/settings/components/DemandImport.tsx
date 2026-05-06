'use client';

/**
 * Demand CSV importer.
 *
 * Operators upload a CSV exported from UDH (or equivalent). The importer
 * parses the file client-side, shows the detected column mapping alongside
 * a preview, and on confirmation writes the demand map to localStorage
 * (`byron-demand-override-v1`). Other pages listen for the storage event
 * and reload their demand view.
 *
 * The mapping contract is surfaced prominently so it's obvious what the
 * CSV must contain — ambiguity here tends to cost operator time.
 */

import { useMemo, useState, useEffect, useRef } from 'react';
import {
  writeDemandOverride,
  clearDemandOverride,
  getDemandOverrideInfo,
  type DemandOverrideInfo,
} from '@/lib/planning/demand-override';

// Matches the column-detection logic in `/api/demand-data/route.ts` so
// CSVs that "just work" on the server also "just work" here.
const CODE_COLUMN_ALIASES = ['product code', 'productcode', 'sku', 'code'];
const DEMAND_COLUMN_ALIASES = ['ave', 'average', 'demand', 'monthly demand'];
const PREVIEW_ROWS = 5;

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let current = '';
  let inQuotes = false;
  let row: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(current.trim());
        current = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(current.trim());
        if (row.some((c) => c !== '')) rows.push(row);
        row = [];
        current = '';
      } else {
        current += ch;
      }
    }
  }
  row.push(current.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

function detectColumn(headers: string[], aliases: string[]): number {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const alias of aliases) {
    const i = lower.indexOf(alias);
    if (i !== -1) return i;
  }
  return -1;
}

interface ParsedPreview {
  headers: string[];
  dataRows: string[][];
  totalRows: number;
  codeCol: number;
  demandCol: number;
  fileName: string;
}

interface ImportSummary {
  totalRows: number;
  importedCount: number;
  skippedInvalid: number;
  dedupedCount: number;
}

function buildImportMap(
  preview: ParsedPreview,
): { demand: Record<string, number>; summary: ImportSummary } {
  const demand: Record<string, number> = {};
  let skipped = 0;
  let deduped = 0;
  for (const row of preview.dataRows) {
    const code = (row[preview.codeCol] || '').trim().toUpperCase();
    const raw = (row[preview.demandCol] || '').replace(/,/g, '').trim();
    const value = parseFloat(raw);
    if (!code || isNaN(value) || value < 0) {
      skipped++;
      continue;
    }
    if (demand[code] !== undefined) deduped++;
    if (demand[code] === undefined || value > demand[code]) {
      demand[code] = Math.round(value);
    }
  }
  return {
    demand,
    summary: {
      totalRows: preview.totalRows,
      importedCount: Object.keys(demand).length,
      skippedInvalid: skipped,
      dedupedCount: deduped,
    },
  };
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)} min ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return new Date(iso).toLocaleString('en-AU');
}

export function DemandImport() {
  const [preview, setPreview] = useState<ParsedPreview | null>(null);
  const [codeCol, setCodeCol] = useState<number>(-1);
  const [demandCol, setDemandCol] = useState<number>(-1);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<DemandOverrideInfo | null>(null);
  const [justImported, setJustImported] = useState<ImportSummary | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setInfo(getDemandOverrideInfo());
  }, []);

  const dry = useMemo(() => {
    if (!preview || codeCol === -1 || demandCol === -1) return null;
    return buildImportMap({ ...preview, codeCol, demandCol });
  }, [preview, codeCol, demandCol]);

  const handleFile = async (file: File) => {
    setError(null);
    setJustImported(null);
    try {
      const text = await file.text();
      const rows = parseCSV(text);
      if (rows.length < 2) {
        setError('CSV appears empty — need a header row plus at least one data row.');
        setPreview(null);
        return;
      }
      const headers = rows[0];
      const dataRows = rows.slice(1);
      const parsed: ParsedPreview = {
        headers,
        dataRows,
        totalRows: dataRows.length,
        codeCol: detectColumn(headers, CODE_COLUMN_ALIASES),
        demandCol: detectColumn(headers, DEMAND_COLUMN_ALIASES),
        fileName: file.name,
      };
      setPreview(parsed);
      setCodeCol(parsed.codeCol);
      setDemandCol(parsed.demandCol);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read file.');
      setPreview(null);
    }
  };

  const handleImport = () => {
    if (!preview || !dry) return;
    if (dry.summary.importedCount === 0) {
      setError('No valid rows found — check the column mapping.');
      return;
    }
    writeDemandOverride(dry.demand, preview.fileName);
    setInfo(getDemandOverrideInfo());
    setJustImported(dry.summary);
    setPreview(null);
    setCodeCol(-1);
    setDemandCol(-1);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleClear = () => {
    if (!confirm('Revert to the server default demand CSV? Your custom rates will be discarded.')) return;
    clearDemandOverride();
    setInfo(null);
    setJustImported(null);
  };

  const handleCancel = () => {
    setPreview(null);
    setCodeCol(-1);
    setDemandCol(-1);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="space-y-4">
      {/* Mapping contract — intentionally prominent. */}
      <div
        className="rounded p-4"
        style={{
          background: 'var(--bg-surface)',
          border: '0.5px solid var(--border)',
        }}
      >
        <div
          className="text-[11px] uppercase tracking-wider mb-2"
          style={{ fontWeight: 600, color: 'var(--text-muted)' }}
        >
          Required columns
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <ColumnContract
            label="Product code"
            hints="Product Code · ProductCode · SKU · Code"
          />
          <ColumnContract
            label="Monthly demand"
            hints="AVE · Average · Demand · Monthly demand"
          />
        </div>
        <p
          className="text-xs mt-3"
          style={{ color: 'var(--text-muted)' }}
        >
          Column names are matched case-insensitively. Extra columns are ignored.
          Duplicate product codes collapse to the largest value.
        </p>
      </div>

      {/* Current override status */}
      {info && !preview && (
        <div
          className="rounded p-3 flex items-center justify-between text-sm"
          style={{
            background: 'var(--accent-light)',
            border: '0.5px solid var(--accent)',
          }}
        >
          <div>
            <div style={{ fontWeight: 500, color: 'var(--accent)' }}>
              Custom demand active · {info.count} product
              {info.count === 1 ? '' : 's'}
            </div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
              {info.sourceFileName || 'unnamed CSV'} · uploaded{' '}
              {formatRelativeTime(info.uploadedAt)}
            </div>
          </div>
          <button
            onClick={handleClear}
            className="text-xs px-3 py-1.5 rounded transition hover:opacity-85"
            style={{
              color: 'var(--danger)',
              background: 'var(--bg-surface)',
              border: '0.5px solid var(--danger)',
            }}
          >
            Revert to server CSV
          </button>
        </div>
      )}

      {/* Success flash */}
      {justImported && (
        <div
          className="rounded p-3 text-sm"
          style={{
            background: 'var(--success-light)',
            border: '0.5px solid var(--success)',
            color: 'var(--success)',
          }}
        >
          Imported {justImported.importedCount} demand rate
          {justImported.importedCount === 1 ? '' : 's'} from{' '}
          {justImported.totalRows} row{justImported.totalRows === 1 ? '' : 's'}
          {justImported.skippedInvalid > 0 &&
            ` · ${justImported.skippedInvalid} invalid row${justImported.skippedInvalid === 1 ? '' : 's'} skipped`}
          {justImported.dedupedCount > 0 &&
            ` · ${justImported.dedupedCount} duplicate${justImported.dedupedCount === 1 ? '' : 's'} collapsed`}
        </div>
      )}

      {/* File picker */}
      {!preview && (
        <div>
          <label
            className="block rounded p-6 text-center cursor-pointer transition hover:opacity-90"
            style={{
              background: 'var(--bg-surface)',
              border: '1px dashed var(--border)',
              color: 'var(--text-secondary)',
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
            <div className="text-sm" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
              Choose a CSV file to import
            </div>
            <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Parsed locally in your browser — nothing uploaded to the server.
            </div>
          </label>
        </div>
      )}

      {error && (
        <div
          className="rounded p-3 text-sm"
          style={{
            background: 'var(--danger-light)',
            border: '0.5px solid var(--danger)',
            color: 'var(--danger)',
          }}
        >
          {error}
        </div>
      )}

      {/* Preview + mapping */}
      {preview && (
        <div className="space-y-3">
          <div
            className="flex items-center justify-between text-sm px-4 py-3 rounded"
            style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
          >
            <div>
              <div style={{ fontWeight: 500 }}>{preview.fileName}</div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {preview.totalRows} row{preview.totalRows === 1 ? '' : 's'} detected
              </div>
            </div>
            <button
              onClick={handleCancel}
              className="text-xs px-3 py-1.5 rounded transition hover:opacity-80"
              style={{
                color: 'var(--text-secondary)',
                border: '0.5px solid var(--border)',
              }}
            >
              Cancel
            </button>
          </div>

          {/* Column mapping — two dropdowns, auto-selected. */}
          <div className="grid grid-cols-2 gap-3">
            <ColumnPicker
              label="Product code column"
              headers={preview.headers}
              value={codeCol}
              onChange={setCodeCol}
              emptyHint="Not detected — pick the column that holds product codes."
            />
            <ColumnPicker
              label="Monthly demand column"
              headers={preview.headers}
              value={demandCol}
              onChange={setDemandCol}
              emptyHint="Not detected — pick the column that holds the AVE / monthly figure."
            />
          </div>

          {/* Preview table */}
          {codeCol !== -1 && demandCol !== -1 && (
            <div
              className="rounded overflow-hidden"
              style={{ border: '0.5px solid var(--border)' }}
            >
              <div
                className="text-[11px] uppercase tracking-wider px-4 py-2"
                style={{
                  fontWeight: 600,
                  color: 'var(--text-muted)',
                  background: 'var(--bg-surface)',
                  borderBottom: '0.5px solid var(--border)',
                }}
              >
                Preview · first {Math.min(PREVIEW_ROWS, preview.totalRows)} row
                {preview.totalRows === 1 ? '' : 's'}
              </div>
              <table
                className="w-full text-xs"
                style={{ background: 'var(--bg-surface)' }}
              >
                <thead>
                  <tr>
                    {preview.headers.map((h, i) => (
                      <th
                        key={i}
                        className="px-3 py-2 text-left"
                        style={{
                          fontWeight: i === codeCol || i === demandCol ? 600 : 400,
                          color:
                            i === codeCol
                              ? 'var(--accent)'
                              : i === demandCol
                                ? 'var(--success)'
                                : 'var(--text-muted)',
                          background:
                            i === codeCol
                              ? 'var(--accent-light)'
                              : i === demandCol
                                ? 'var(--success-light)'
                                : undefined,
                          borderBottom: '0.5px solid var(--border)',
                        }}
                      >
                        {h || <em style={{ opacity: 0.5 }}>(blank)</em>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.dataRows.slice(0, PREVIEW_ROWS).map((row, ri) => (
                    <tr key={ri}>
                      {preview.headers.map((_, ci) => (
                        <td
                          key={ci}
                          className="px-3 py-1.5"
                          style={{
                            background:
                              ci === codeCol
                                ? 'var(--accent-light)'
                                : ci === demandCol
                                  ? 'var(--success-light)'
                                  : undefined,
                            color:
                              ci === codeCol || ci === demandCol
                                ? 'var(--text-primary)'
                                : 'var(--text-muted)',
                            fontWeight:
                              ci === codeCol || ci === demandCol ? 500 : 400,
                            borderBottom:
                              ri < Math.min(PREVIEW_ROWS, preview.totalRows) - 1
                                ? '0.5px solid var(--border)'
                                : undefined,
                          }}
                        >
                          {row[ci] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Import summary + button */}
          {dry && (
            <div className="flex items-center justify-between">
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Will import <strong style={{ color: 'var(--text-primary)' }}>{dry.summary.importedCount}</strong> demand rate
                {dry.summary.importedCount === 1 ? '' : 's'}
                {dry.summary.skippedInvalid > 0 &&
                  ` · ${dry.summary.skippedInvalid} invalid`}
                {dry.summary.dedupedCount > 0 &&
                  ` · ${dry.summary.dedupedCount} duplicate${dry.summary.dedupedCount === 1 ? '' : 's'} collapsed to max`}
              </div>
              <button
                onClick={handleImport}
                disabled={dry.summary.importedCount === 0}
                className="text-sm px-4 py-2 rounded text-white transition hover:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'var(--accent)', fontWeight: 500 }}
              >
                Import {dry.summary.importedCount} rate
                {dry.summary.importedCount === 1 ? '' : 's'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────

function ColumnContract({ label, hints }: { label: string; hints: string }) {
  return (
    <div
      className="rounded p-3"
      style={{ background: 'var(--bg-page)', border: '0.5px solid var(--border)' }}
    >
      <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{label}</div>
      <div
        className="text-xs mt-1 font-mono"
        style={{ color: 'var(--text-muted)' }}
      >
        {hints}
      </div>
    </div>
  );
}

function ColumnPicker({
  label,
  headers,
  value,
  onChange,
  emptyHint,
}: {
  label: string;
  headers: string[];
  value: number;
  onChange: (idx: number) => void;
  emptyHint: string;
}) {
  const detected = value !== -1;
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <label
          className="text-[11px] uppercase tracking-wider"
          style={{ fontWeight: 600, color: 'var(--text-muted)' }}
        >
          {label}
        </label>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded"
          style={{
            fontWeight: 500,
            background: detected ? 'var(--success-light)' : 'var(--warning-light)',
            color: detected ? 'var(--success)' : 'var(--warning)',
          }}
        >
          {detected ? 'auto-detected' : 'pick one'}
        </span>
      </div>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full px-3 py-2 rounded text-sm"
        style={{
          background: 'var(--bg-page)',
          border: `0.5px solid ${detected ? 'var(--border)' : 'var(--warning)'}`,
          color: 'var(--text-primary)',
        }}
      >
        <option value={-1}>— Not selected —</option>
        {headers.map((h, i) => (
          <option key={i} value={i}>
            {h || `(col ${i + 1})`}
          </option>
        ))}
      </select>
      {!detected && (
        <div className="text-xs mt-1" style={{ color: 'var(--warning)' }}>
          {emptyHint}
        </div>
      )}
    </div>
  );
}
