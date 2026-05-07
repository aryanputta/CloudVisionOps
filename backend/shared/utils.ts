import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createHash } from 'crypto';

// ---- Environment ----

export function getEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function getEnvVarOrDefault(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

// ---- Logger (structured JSON, CloudWatch-friendly) ----

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

interface LogEntry {
  level: LogLevel;
  message: string;
  service: string;
  timestamp: string;
  [key: string]: unknown;
}

export function createLogger(service: string) {
  const minLevel = (process.env.LOG_LEVEL ?? 'INFO') as LogLevel;
  const levels: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

  function log(level: LogLevel, message: string, extra?: Record<string, unknown>) {
    if (levels[level] < levels[minLevel]) return;
    const entry: LogEntry = {
      level,
      message,
      service,
      timestamp: new Date().toISOString(),
      ...extra,
    };
    // Avoid logging sensitive fields
    const safe = sanitizeLog(entry);
    console.log(JSON.stringify(safe));
  }

  return {
    debug: (msg: string, extra?: Record<string, unknown>) => log('DEBUG', msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => log('INFO', msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => log('WARN', msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => log('ERROR', msg, extra),
  };
}

function sanitizeLog(entry: Record<string, unknown>): Record<string, unknown> {
  const SENSITIVE_KEYS = ['authorization', 'password', 'token', 'secret', 'credential'];
  return Object.fromEntries(
    Object.entries(entry).filter(([k]) => !SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s)))
  );
}

// ---- DynamoDB client ----

let _ddbClient: DynamoDBDocumentClient | null = null;

export function getDDBClient(): DynamoDBDocumentClient {
  if (!_ddbClient) {
    const client = new DynamoDBClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      maxAttempts: 3,
    });
    _ddbClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return _ddbClient;
}

// ---- SQS client ----

let _sqsClient: SQSClient | null = null;

export function getSQSClient(): SQSClient {
  if (!_sqsClient) {
    _sqsClient = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1', maxAttempts: 3 });
  }
  return _sqsClient;
}

// ---- Image hashing ----

export function calculateImageHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function calculateS3KeyHash(bucket: string, key: string, etag?: string): string {
  return createHash('sha256').update(`${bucket}::${key}::${etag ?? ''}`).digest('hex');
}

// ---- Latency ----

export function calculateLatency(startMs: number): number {
  return Date.now() - startMs;
}

// ---- Idempotency (DynamoDB conditional write) ----

export async function acquireIdempotencyLock(
  idempotencyKey: string,
  ttlSeconds: number = 86400
): Promise<boolean> {
  const table = process.env.IDEMPOTENCY_TABLE;
  if (!table) return true; // Skip if table not configured

  const ddb = getDDBClient();
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;

  try {
    await ddb.send(new PutCommand({
      TableName: table,
      Item: { idempotencyKey, expiry, createdAt: new Date().toISOString() },
      ConditionExpression: 'attribute_not_exists(idempotencyKey)',
    }));
    return true; // Lock acquired — proceed
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      return false; // Already processed
    }
    throw err;
  }
}

// ---- DynamoDB helpers ----

export async function writeMetadata(tableName: string, item: Record<string, unknown>): Promise<void> {
  const ddb = getDDBClient();
  await ddb.send(new PutCommand({ TableName: tableName, Item: item }));
}

export async function updateImageStatus(
  tableName: string,
  imageId: string,
  updates: Record<string, unknown>
): Promise<void> {
  const ddb = getDDBClient();
  const now = new Date().toISOString();

  const expressionParts: string[] = [];
  const attrNames: Record<string, string> = {};
  const attrValues: Record<string, unknown> = { ':updatedAt': now };

  Object.entries(updates).forEach(([key, value], i) => {
    const nameAlias = `#f${i}`;
    const valueAlias = `:v${i}`;
    attrNames[nameAlias] = key;
    attrValues[valueAlias] = value;
    expressionParts.push(`${nameAlias} = ${valueAlias}`);
  });

  attrNames['#updatedAt'] = 'updatedAt';
  expressionParts.push('#updatedAt = :updatedAt');

  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { imageId },
    UpdateExpression: `SET ${expressionParts.join(', ')}`,
    ExpressionAttributeNames: attrNames,
    ExpressionAttributeValues: attrValues,
  }));
}

// ---- SQS DLQ ----

export async function sendToDlq(
  dlqUrl: string,
  body: Record<string, unknown>,
  attributes?: Record<string, string>
): Promise<void> {
  const sqs = getSQSClient();
  const messageAttributes: Record<string, { DataType: string; StringValue: string }> = {};

  if (attributes) {
    Object.entries(attributes).forEach(([k, v]) => {
      messageAttributes[k] = { DataType: 'String', StringValue: v };
    });
  }

  await sqs.send(new SendMessageCommand({
    QueueUrl: dlqUrl,
    MessageBody: JSON.stringify(body),
    MessageAttributes: messageAttributes,
  }));
}

// ---- S3 event parsing ----

export interface S3EventRecord {
  bucket: string;
  key: string;
  size: number;
  etag: string;
  eventTime: string;
  region: string;
}

export function parseS3Event(event: any): S3EventRecord[] {
  if (!event?.Records) throw new Error('Invalid S3 event: missing Records');

  return event.Records.map((record: any) => {
    const s3 = record.s3;
    if (!s3) throw new Error('Invalid S3 event record: missing s3 field');

    return {
      bucket: s3.bucket.name,
      key: decodeURIComponent(s3.object.key.replace(/\+/g, ' ')),
      size: s3.object.size ?? 0,
      etag: s3.object.eTag?.replace(/"/g, '') ?? '',
      eventTime: record.eventTime,
      region: record.awsRegion,
    };
  });
}

// ---- Rekognition helpers ----

export interface LabelResult {
  name: string;
  confidence: number;
  categories: string[];
  parents: string[];
  hasBoundingBox: boolean;
}

export function parseRekognitionLabels(labels: any[]): LabelResult[] {
  return labels.map((label) => ({
    name: label.Name,
    confidence: label.Confidence,
    categories: label.Categories?.map((c: any) => c.Name) ?? [],
    parents: label.Parents?.map((p: any) => p.Name) ?? [],
    hasBoundingBox: (label.Instances?.length ?? 0) > 0,
  }));
}

export function getDominantLabel(labels: LabelResult[]): string {
  if (labels.length === 0) return 'UNKNOWN';
  return labels.reduce((a, b) => (a.confidence > b.confidence ? a : b)).name;
}

// ---- Error types ----

export type ErrorType =
  | 'S3_READ_ERROR'
  | 'REKOGNITION_ERROR'
  | 'DYNAMODB_WRITE_ERROR'
  | 'TIMEOUT_ERROR'
  | 'VALIDATION_ERROR'
  | 'DUPLICATE_DETECTED'
  | 'UNKNOWN_ERROR';

export function classifyError(err: unknown): ErrorType {
  if (!(err instanceof Error)) return 'UNKNOWN_ERROR';
  const name = err.name;
  const msg = err.message.toLowerCase();

  if (name === 'NoSuchKey' || msg.includes('s3') || msg.includes('nosuchkey')) return 'S3_READ_ERROR';
  if (msg.includes('rekognition') || name === 'InvalidImageException' || name === 'ImageTooLargeException') return 'REKOGNITION_ERROR';
  if (msg.includes('dynamodb') || name === 'ProvisionedThroughputExceededException' || name === 'ConditionalCheckFailedException') return 'DYNAMODB_WRITE_ERROR';
  if (msg.includes('timeout') || name === 'TimeoutError') return 'TIMEOUT_ERROR';
  if (msg.includes('validation') || msg.includes('invalid')) return 'VALIDATION_ERROR';

  return 'UNKNOWN_ERROR';
}

// ---- API response helpers ----

export function apiResponse(statusCode: number, body: unknown, headers?: Record<string, string>) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Idempotency-Key',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

// ---- Exponential backoff with full jitter ----
//
// Full jitter: sleep = random(0, min(cap, base * 2^attempt))
//
// Why full jitter over equal jitter (sleep = base * 2^attempt):
// Equal jitter causes retry storms — every caller that failed at the same time
// retries at the same time. Under Rekognition throttling, this makes the problem
// worse. Full jitter spreads retries randomly across the window, reducing
// thundering herd by roughly (1 - 1/n) for n callers.
//
// Why not decorrelated jitter (sleep = random(base, prev_sleep * 3)):
// Decorrelated can produce arbitrarily long waits and is harder to reason about.
// Full jitter with a 30s cap gives predictable worst-case behavior.
//
// Reference: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelayMs: number = 100
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        const cap = 30000;
        const delay = Math.random() * Math.min(cap, baseDelayMs * Math.pow(2, attempt));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
