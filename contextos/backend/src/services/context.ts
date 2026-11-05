import type pg from "pg";
import type { GeminiClient } from "../ai/gemini.js";

/** Everything a service needs. Created once in app.ts, passed explicitly (no globals). */
export interface ServiceContext {
  pool: pg.Pool;
  gemini: GeminiClient | null;
  log: { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void };
}

export class NotFoundError extends Error {
  statusCode = 404;
}
export class BadRequestError extends Error {
  statusCode = 400;
}
export class ConflictError extends Error {
  statusCode = 409;
}
