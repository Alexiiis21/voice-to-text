import Link from 'next/link';

export default function NotFound(): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-950 px-5">
      <div className="panel max-w-lg">
        <header className="panel-bar">
          <span className="panel-dots" aria-hidden="true" />
          <span className="micro">404</span>
        </header>
        <div className="space-y-4 p-5">
          <h1 className="text-2xl font-bold tracking-tightest text-fg">Página no encontrada</h1>
          <Link href="/" className="btn inline-block">
            VOLVER AL INICIO
          </Link>
        </div>
      </div>
    </div>
  );
}
