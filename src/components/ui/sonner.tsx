'use client';

import { Toaster as Sonner, type ToasterProps } from 'sonner';

/**
 * Toasts. Tema forzado a oscuro y sin iconos: la estética es terminal, sin
 * emojis ni ilustraciones (§8).
 */
export function Toaster(props: ToasterProps): React.JSX.Element {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      icons={{
        success: null,
        info: null,
        warning: null,
        error: null,
        loading: null,
      }}
      toastOptions={{
        classNames: {
          toast:
            'group !bg-ink-900 !border !border-line !rounded-none !shadow-none !text-fg !font-mono !text-[11px] !uppercase !tracking-micro',
          description: '!text-fg-muted !normal-case !tracking-normal !font-sans !text-sm',
          actionButton: '!bg-transparent !text-accent-from !rounded-none',
          cancelButton: '!bg-transparent !text-fg-faint !rounded-none',
        },
      }}
      {...props}
    />
  );
}
