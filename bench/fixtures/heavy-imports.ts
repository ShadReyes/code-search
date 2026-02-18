import { Router, Request, Response, NextFunction } from 'express';
import { z, ZodSchema, ZodError } from 'zod';
import type { Logger } from 'winston';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { Redis } from 'ioredis';
import { sign, verify, JwtPayload } from 'jsonwebtoken';
import { hash, compare } from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { Readable, Transform } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';
import { createHash, randomBytes } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { join, resolve, basename } from 'path';
import type { Job, Queue, Worker } from 'bullmq';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { SendEmailCommandInput } from '@aws-sdk/client-ses';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import type { Knex } from 'knex';
import { default as dayjs } from 'dayjs';
import type { Stripe } from 'stripe';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import { default as pino } from 'pino';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { default as Ajv, ValidateFunction } from 'ajv';
import type { Connection, Channel, ConsumeMessage } from 'amqplib';
import type { Document, Model, Schema as MongooseSchema } from 'mongoose';
import { Mutex, Semaphore } from 'async-mutex';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ServiceConfig {
  port: number;
  host: string;
  environment: 'development' | 'staging' | 'production';
  logLevel: string;
  database: {
    connectionString: string;
    poolSize: number;
    idleTimeout: number;
  };
  redis: {
    url: string;
    keyPrefix: string;
  };
  jwt: {
    secret: string;
    expiresIn: string;
    issuer: string;
  };
  s3: {
    bucket: string;
    region: string;
  };
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  handler: (req: Request, res: Response) => Promise<void>;
  middleware?: Array<(req: Request, res: Response, next: NextFunction) => void>;
  schema?: ZodSchema;
}

export interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  etag: string;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: Partial<ServiceConfig> = {
  port: 3000,
  host: '0.0.0.0',
  environment: 'development',
  logLevel: 'info',
};

export const RATE_LIMITS = {
  api: { points: 100, duration: 60 },
  auth: { points: 10, duration: 300 },
  upload: { points: 5, duration: 60 },
} as const;

// ─── Validation ───────────────────────────────────────────────────────────────

export function validateRequestBody<T>(schema: ZodSchema<T>, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      const messages = err.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
      throw new ValidationError('Request validation failed', messages);
    }
    throw err;
  }
}

export class ValidationError extends Error {
  public readonly fields: string[];

  constructor(message: string, fields: string[]) {
    super(message);
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

// ─── Authentication ───────────────────────────────────────────────────────────

export async function hashPassword(password: string, rounds: number = 12): Promise<string> {
  return hash(password, rounds);
}

export async function verifyPassword(password: string, hashed: string): Promise<boolean> {
  return compare(password, hashed);
}

export function generateToken(
  payload: Record<string, unknown>,
  secret: string,
  expiresIn: string = '24h'
): string {
  return sign(payload, secret, {
    expiresIn,
    issuer: 'code-search-bench',
    jwtid: uuidv4(),
  });
}

export function verifyToken(token: string, secret: string): JwtPayload {
  const decoded = verify(token, secret);
  if (typeof decoded === 'string') {
    throw new Error('Expected object payload from JWT');
  }
  return decoded;
}

// ─── Caching ──────────────────────────────────────────────────────────────────

export function createCacheKey(...parts: string[]): string {
  const raw = parts.join(':');
  return createHash('sha256').update(raw).digest('hex').substring(0, 16);
}

export async function withCache<T>(
  redis: Redis,
  key: string,
  ttlSeconds: number,
  factory: () => Promise<T>
): Promise<T> {
  const cached = await redis.get(key);
  if (cached !== null) {
    try {
      const entry: CacheEntry<T> = JSON.parse(cached);
      if (entry.expiresAt > Date.now()) {
        return entry.data;
      }
    } catch {
      // corrupted cache entry, fall through
    }
  }

  const data = await factory();
  const entry: CacheEntry<T> = {
    data,
    expiresAt: Date.now() + ttlSeconds * 1000,
    etag: createHash('md5').update(JSON.stringify(data)).digest('hex'),
  };

  await redis.set(key, JSON.stringify(entry), 'EX', ttlSeconds);
  return data;
}

// ─── File Operations ──────────────────────────────────────────────────────────

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const absolutePath = resolve(filePath);
  const content = await readFile(absolutePath, 'utf-8');
  return JSON.parse(content) as T;
}

export async function writeJsonFile<T>(filePath: string, data: T, pretty: boolean = true): Promise<void> {
  const absolutePath = resolve(filePath);
  const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  await writeFile(absolutePath, content, 'utf-8');
}

export function generateSafeFilename(originalName: string): string {
  const ext = basename(originalName).split('.').pop() ?? '';
  const timestamp = dayjs().format('YYYYMMDD-HHmmss');
  const random = randomBytes(4).toString('hex');
  return `${timestamp}-${random}.${ext}`;
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

export function createRateLimiter(
  category: keyof typeof RATE_LIMITS
): RateLimiterMemory {
  const config = RATE_LIMITS[category];
  return new RateLimiterMemory({
    points: config.points,
    duration: config.duration,
  });
}

export async function checkRateLimit(
  limiter: RateLimiterMemory,
  key: string
): Promise<{ allowed: boolean; remainingPoints: number; resetMs: number }> {
  try {
    const result = await limiter.consume(key);
    return {
      allowed: true,
      remainingPoints: result.remainingPoints,
      resetMs: result.msBeforeNext,
    };
  } catch (rejRes: any) {
    return {
      allowed: false,
      remainingPoints: 0,
      resetMs: rejRes.msBeforeNext ?? 0,
    };
  }
}

// ─── Retry Logic ──────────────────────────────────────────────────────────────

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelayMs: number = 500,
  backoffMultiplier: number = 2
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(backoffMultiplier, attempt - 1);
        const jitter = Math.random() * delay * 0.1;
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
      }
    }
  }

  throw lastError!;
}

// ─── Middleware Factory ───────────────────────────────────────────────────────

export function createLoggingMiddleware(logger: pino.Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    const requestId = uuidv4();

    res.setHeader('X-Request-Id', requestId);

    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info({
        requestId,
        method: req.method,
        url: req.url,
        status: res.statusCode,
        durationMs: duration,
      });
    });

    next();
  };
}

export function createErrorHandler(logger: pino.Logger) {
  return (err: Error, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof ValidationError) {
      res.status(400).json({
        error: 'Validation Error',
        message: err.message,
        fields: err.fields,
      });
      return;
    }

    logger.error({ err }, 'Unhandled error');
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
    });
  };
}

// ─── Concurrency Helpers ──────────────────────────────────────────────────────

export async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  processor: (batch: T[]) => Promise<R[]>
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await processor(batch);
    results.push(...batchResults);
  }

  return results;
}

export async function withMutex<T>(mutex: Mutex, fn: () => Promise<T>): Promise<T> {
  const release = await mutex.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
