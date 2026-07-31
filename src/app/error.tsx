'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-950 px-5">
      <div className="panel max-w-lg">
        <header className="panel-bar">
          <span className="panel-dots" aria-hidden="true" />
          <span className="micro">ERROR</span>
        </header>
        <div className="space-y-4 p-5">
          <h1 className="text-2xl font-bold tracking-tightest text-fg">Algo se ha roto</h1>
          <p className="text-sm text-fg-muted">{error.message}</p>
          {error.digest && <p className="micro">DIGEST: {error.digest}</p>}
          <button type="button" className="btn" onClick={reset}>
            REINTENTAR
          </button>
        </div>
      </div>
    </div>
  );
}
