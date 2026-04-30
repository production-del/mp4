'use client';

interface ErrorBannerProps {
  message: string;
  onRetry: () => void;
}

/**
 * Error banner shown when Unleashed data fails to load.
 * Provides a retry button and indicates fallback to mock data.
 */
export function ErrorBanner({ message, onRetry }: ErrorBannerProps) {
  return (
    <div
      className="rounded-lg mx-6 mt-4 p-4"
      style={{ background: 'var(--danger-light)', border: '0.5px solid var(--danger)' }}
    >
      <div className="flex items-start gap-3">
        <span className="text-lg flex-shrink-0" style={{ color: 'var(--danger)' }}>!</span>
        <div className="flex-1">
          <h3 className="text-sm" style={{ fontWeight: 500, color: 'var(--danger)' }}>
            Failed to load live data from Unleashed
          </h3>
          <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{message}</p>
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
            Showing mock data as fallback. Your changes won&apos;t reflect live inventory.
          </p>
        </div>
        <button
          onClick={onRetry}
          className="px-3 py-1.5 rounded text-xs transition hover:opacity-70 flex-shrink-0"
          style={{ fontWeight: 500, color: 'var(--danger)', border: '0.5px solid var(--danger)' }}
        >
          Retry
        </button>
      </div>
    </div>
  );
}
