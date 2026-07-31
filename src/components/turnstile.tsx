'use client';

import { useEffect, useId, useRef } from 'react';

interface TurnstileRenderOptions {
  sitekey: string;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'compact' | 'flexible';
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
}

interface TurnstileApi {
  render: (element: HTMLElement, options: TurnstileRenderOptions) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    onTranscriptorTurnstileLoad?: () => void;
  }
}

const SCRIPT_ID = 'cf-turnstile-script';
const SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTranscriptorTurnstileLoad';

interface TurnstileProps {
  siteKey: string | null;
  onToken: (token: string | null) => void;
}

/**
 * Widget de Cloudflare Turnstile, renderizado en modo explícito.
 *
 * Si no hay site key configurada (desarrollo local), no renderiza nada y avisa
 * al padre con `null`: el servidor también salta la verificación cuando falta
 * `TURNSTILE_SECRET_KEY`.
 */
export function Turnstile({ siteKey, onToken }: TurnstileProps): React.JSX.Element | null {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  const domId = useId();

  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    if (!siteKey) return;

    let cancelled = false;

    const render = (): void => {
      if (cancelled) return;
      const api = window.turnstile;
      const element = containerRef.current;
      if (!api || !element || widgetIdRef.current !== null) return;

      widgetIdRef.current = api.render(element, {
        sitekey: siteKey,
        theme: 'dark',
        size: 'flexible',
        callback: (token: string) => onTokenRef.current(token),
        'expired-callback': () => onTokenRef.current(null),
        'error-callback': () => onTokenRef.current(null),
      });
    };

    if (window.turnstile) {
      render();
    } else {
      window.onTranscriptorTurnstileLoad = render;
      if (!document.getElementById(SCRIPT_ID)) {
        const script = document.createElement('script');
        script.id = SCRIPT_ID;
        script.src = SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
    }

    return () => {
      cancelled = true;
      const api = window.turnstile;
      const widgetId = widgetIdRef.current;
      if (api && widgetId !== null) {
        try {
          api.remove(widgetId);
        } catch {
          // El widget ya se había destruido.
        }
      }
      widgetIdRef.current = null;
    };
  }, [siteKey]);

  if (!siteKey) return null;

  return <div id={domId} ref={containerRef} className="max-w-[300px]" />;
}
