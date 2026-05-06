'use client';

/**
 * Loading skeleton that mirrors the kitchen planner 3-panel layout.
 * Shown while Unleashed data is being fetched.
 */
export function LoadingSkeleton() {
  return (
    <div className="h-screen flex flex-col animate-pulse" style={{ background: 'var(--bg-page)' }}>
      {/* Top bar skeleton */}
      <div className="px-6 py-4" style={{ borderBottom: '0.5px solid var(--border)' }}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="h-7 w-64 rounded" style={{ background: 'var(--bg-surface)' }} />
            <div className="h-4 w-48 rounded mt-2" style={{ background: 'var(--bg-hover)' }} />
          </div>
          <div className="flex gap-3">
            <div className="h-9 w-20 rounded" style={{ background: 'var(--bg-surface)' }} />
            <div className="h-9 w-24 rounded" style={{ background: 'var(--bg-surface)' }} />
            <div className="h-9 w-32 rounded" style={{ background: 'var(--bg-surface)' }} />
          </div>
        </div>
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="rounded px-3 py-2"
              style={{ background: 'var(--bg-surface)' }}
            >
              <div className="h-3 w-16 rounded" style={{ background: 'var(--bg-hover)' }} />
              <div className="h-6 w-10 rounded mt-2" style={{ background: 'var(--bg-hover)' }} />
            </div>
          ))}
        </div>
      </div>

      {/* Main layout skeleton */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar skeleton */}
        <div className="w-80 p-4 space-y-4" style={{ borderRight: '0.5px solid var(--border)' }}>
          <div className="h-5 w-24 rounded" style={{ background: 'var(--bg-surface)' }} />
          <div className="h-3 w-32 rounded" style={{ background: 'var(--bg-hover)' }} />
          <div className="space-y-3 mt-6">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="rounded p-3"
                style={{ background: 'var(--bg-surface)' }}
              >
                <div className="h-4 w-28 rounded mb-2" style={{ background: 'var(--bg-hover)' }} />
                <div className="h-3 w-20 rounded" style={{ background: 'var(--bg-hover)' }} />
              </div>
            ))}
          </div>
        </div>

        {/* Calendar skeleton */}
        <div className="flex-1 p-4">
          <div className="grid grid-cols-5 gap-3">
            {Array.from({ length: 15 }).map((_, i) => (
              <div
                key={i}
                className="h-36 rounded"
                style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--border)' }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
