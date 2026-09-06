/**
 * Emisión del token de subida directa a Vercel Blob.
 *
 * Por qué el cliente sube directo y no a través de una ruta nuestra: el cuerpo
 * de una petición a una función serverless de Vercel está limitado a 4,5 MB, y
 * aquí se suben audios de cientos de MB. Con la subida directa el audio va del
 * navegador a Blob sin pasar por ninguna función, así que el límite no aplica.
 *
 * Lo que se conserva del flujo anterior es el **orden de las comprobaciones**:
 * Turnstile y rate limit se resuelven aquí, antes de emitir el token, o sea
 * antes de que se escriba un solo byte. Un cliente sin token no puede subir
 * nada a nuestro almacén.
 */
import { NextResponse } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { ALLOWED_MIME_TYPES } from '@/lib/config';
import { env } from '@/lib/env';
import { validatedExtension } from '@/lib/files';
import { clientIp, reserveTranscription } from '@/lib/rate-limit';
import { safeErrorMessage } from '@/lib/redact';
import { verifyTurnstile } from '@/lib/turnstile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ClientPayload {
  turnstileToken?: string | null;
  filename?: string;
}

function parsePayload(raw: string | null): ClientPayload {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ClientPayload;
  } catch {
    return {};
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientIp(request.headers);

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: 'Cuerpo ilegible' }, { status: 400 });
  }

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayloadRaw) => {
        const payload = parsePayload(clientPayloadRaw);

        // 1. Turnstile. Igual que antes: lo primero de todo.
        const turnstile = await verifyTurnstile(payload.turnstileToken ?? null, ip);
        if (!turnstile.ok) {
          throw new Error(turnstile.reason ?? 'Verificación antibot fallida');
        }

        // 2. Allowlist de extensión sobre el nombre que propone el cliente.
        //    La ruta real del blob la fija el SDK; esto sólo decide si se
        //    acepta el formato.
        const ext = validatedExtension(payload.filename ?? pathname);
        if (!ext) {
          throw new Error(
            'Formato no soportado. Formatos válidos: .ogg .opus .mp3 .m4a .wav .webm .aac .flac',
          );
        }

        // 3. Rate limit por IP. Sólo el contador de transcripciones: los
        //    segundos de audio se contabilizan al procesar, que es cuando se
        //    conoce la duración real (ver columna client_ip del esquema).
        const decision = await reserveTranscription(ip);
        if (!decision.allowed) {
          throw new Error(decision.reason ?? 'Límite de uso alcanzado');
        }

        console.log(
          `[blob] Token emitido para "${payload.filename ?? pathname}" (${ext}), ` +
            `máx ${env.maxUploadMb} MB`,
        );

        return {
          allowedContentTypes: [...ALLOWED_MIME_TYPES],
          maximumSizeInBytes: env.maxUploadMb * 1024 * 1024,
          // Sufijo aleatorio: dos audios con el mismo nombre no se pisan, y la
          // URL resultante no se puede adivinar a partir del nombre original.
          addRandomSuffix: true,
        };
      },

      // `onUploadCompleted` se omite a propósito. El registro en base de datos
      // lo crea el cliente con POST /api/transcriptions al terminar la subida,
      // porque Vercel no puede entregar ese callback a un `next dev` en
      // localhost y partir el flujo en dos caminos sólo traería divergencias.
      //
      // Declararlo vacío tampoco es gratis: el SDK exige entonces una
      // `callbackUrl` y avisa en cada subida con
      // "onUploadCompleted provided but no callbackUrl could be determined".
    });

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = safeErrorMessage(error);
    console.error('[api] Subida a Blob rechazada:', message);
    // 400: los fallos aquí son de validación (antibot, formato, cuota), no del
    // servidor. El cliente muestra el mensaje tal cual.
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
