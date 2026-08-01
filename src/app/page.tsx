import { Transcriber } from '@/components/transcriber';
import { WORKER } from '@/lib/config';
import { env } from '@/lib/env';
import { defaultProviderName, listProviders } from '@/lib/stt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Server Component: lee la configuración del servidor y pasa al cliente sólo
 * lo que es público. Ningún secreto cruza esta frontera.
 */
export default function HomePage(): React.JSX.Element {
  return (
    <Transcriber
      turnstileSiteKey={env.turnstileSiteKey}
      maxUploadMb={env.maxUploadMb}
      cleanupEnabledByDefault={env.enableCleanup}
      retentionDays={WORKER.retentionDays}
      providers={listProviders()}
      defaultProvider={defaultProviderName()}
    />
  );
}
