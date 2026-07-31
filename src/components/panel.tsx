import { cn } from '@/lib/utils';

interface PanelProps {
  /** Micro-etiqueta monoespaciada de la barra superior. */
  label: string;
  /** Marca el panel como activo: borde con el gradiente de acento. */
  active?: boolean;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}

/**
 * Caja con borde de 1 px y barra superior tipo ventana de terminal:
 * tres puntos grises de 12 px a la izquierda, micro-etiqueta a la derecha (§8).
 */
export function Panel({
  label,
  active = false,
  className,
  bodyClassName,
  children,
}: PanelProps): React.JSX.Element {
  return (
    <section className={cn('panel', active && 'panel-active', className)}>
      <header className="panel-bar">
        <span className="panel-dots" aria-hidden="true" />
        <span className="micro">{label}</span>
      </header>
      <div className={cn('p-4 sm:p-5', bodyClassName)}>{children}</div>
    </section>
  );
}
