import {
  bigint,
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const transcriptionStatusEnum = pgEnum('transcription_status', [
  'queued',
  'processing',
  'transcribed',
  'editing',
  'done',
  'failed',
]);

export const chunkStatusEnum = pgEnum('chunk_status', ['pending', 'done', 'failed']);

export const transcriptions = pgTable(
  'transcriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Cookie anónima; historial por navegador. No es un mecanismo de seguridad. */
    sessionId: text('session_id').notNull(),
    filename: text('filename').notNull(),
    /**
     * Extensión validada por el servidor. No está en el esquema de §3 pero es
     * necesaria para localizar el fichero en disco sin usar jamás el nombre que
     * envía el cliente para construir una ruta.
     */
    sourceExt: text('source_ext').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    durationSec: integer('duration_sec'),
    status: transcriptionStatusEnum('status').notNull().default('queued'),
    sttProvider: text('stt_provider').notNull(),
    chunkCount: integer('chunk_count').notNull().default(0),
    rawText: text('raw_text'),
    cleanText: text('clean_text'),
    summaryText: text('summary_text'),
    wordCount: integer('word_count'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 5 }).notNull().default('0'),
    error: text('error'),
    /**
     * No reclamar antes de esta marca. Se rellena cuando todos los proveedores
     * STT están sin cuota: el trabajo vuelve a `queued` y el worker sigue con
     * otros en vez de bloquearse esperando a que se abra la ventana horaria.
     */
    resumeAfter: timestamp('resume_after', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    // El worker reclama trabajos filtrando por status y ordenando por fecha.
    index('transcriptions_status_created_at_idx').on(table.status, table.createdAt),
    // El historial filtra siempre por session_id.
    index('transcriptions_session_created_at_idx').on(table.sessionId, table.createdAt),
  ],
);

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transcriptionId: uuid('transcription_id')
      .notNull()
      .references(() => transcriptions.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    startSec: numeric('start_sec', { precision: 12, scale: 3 }).notNull(),
    endSec: numeric('end_sec', { precision: 12, scale: 3 }).notNull(),
    /** true si este fragmento arranca con 1,5 s de solape sobre el anterior. */
    hasOverlap: boolean('has_overlap').notNull().default(false),
    status: chunkStatusEnum('status').notNull().default('pending'),
    /** Proveedor que transcribió realmente este fragmento (puede diferir del
     *  pedido si hubo desbordamiento por cuota). */
    sttProvider: text('stt_provider'),
    rawText: text('raw_text'),
    cleanText: text('clean_text'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
  },
  (table) => [uniqueIndex('chunks_transcription_id_idx_idx').on(table.transcriptionId, table.idx)],
);

export const rateLimits = pgTable(
  'rate_limits',
  {
    ip: text('ip').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
    /**
     * Segundos de audio consumidos en la ventana. No está en §3 pero el límite
     * de "6 horas de audio por hora" no es computable sin él.
     */
    audioSeconds: integer('audio_seconds').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.ip, table.windowStart] })],
);

/** Estado interno del worker: marca de tiempo del último barrido de retención. */
export const workerState = pgTable('worker_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Transcription = typeof transcriptions.$inferSelect;
export type NewTranscription = typeof transcriptions.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;
export type TranscriptionStatus = Transcription['status'];
export type ChunkStatus = Chunk['status'];
