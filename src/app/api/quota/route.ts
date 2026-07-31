import { NextResponse } from 'next/server';
import { clientIp, readQuota } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cuota restante de la IP en la ventana horaria actual.
 *
 * No está en la tabla de §5; se añade porque la barra superior muestra
 * "USOS RESTANTES: n" y no hay forma de calcularlo en el cliente.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const quota = await readQuota(clientIp(request.headers));
  return NextResponse.json(quota);
}
