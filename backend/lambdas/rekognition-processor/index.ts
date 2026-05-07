import { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import {
  RekognitionClient,
  DetectLabelsCommand,
  DetectModerationLabelsCommand,
} from '@aws-sdk/client-rekognition';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createHash } from 'crypto';
import {
  getEnvVar,
  createLogger,
  parseS3Event,
  parseRekognitionLabels,
  getDominantLabel,
  calculateLatency,
  updateImageStatus,
  sendToDlq,
  classifyError,
  acquireIdempotencyLock,
  withRetry,
  getDDBClient,
  calculateS3KeyHash,
  LabelResult,
} from '../../shared/utils';

const logger = createLogger('RekognitionProcessor');

const s3Client = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const rekClient = new RekognitionClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

const IMAGE_METADATA_TABLE = () => getEnvVar('IMAGE_METADATA_TABLE');
const DLQ_URL = () => getEnvVar('DLQ_URL');
const MAX_LABELS = parseInt(process.env.REKOGNITION_MAX_LABELS ?? '20', 10);
const MIN_CONFIDENCE = parseInt(process.env.REKOGNITION_MIN_CONFIDENCE ?? '70', 10);
const ENABLE_DUPLICATE = process.env.ENABLE_DUPLICATE_DETECTION === 'true';

let coldStart = true;

export const handler = async (event: S3Event): Promise<void> => {
  const isCold = coldStart;
  coldStart = false;

  const records = parseS3Event(event);
  logger.info('Processing S3 event', { recordCount: records.length, coldStart: isCold });

  await Promise.allSettled(records.map((record) => processRecord(record, isCold)));
};

async function processRecord(
  record: ReturnType<typeof parseS3Event>[number],
  isCold: boolean
): Promise<void> {
  const { bucket, key, etag } = record;
  const processingStart = Date.now();

  // Derive imageId from the object key path: uploads/{userId}/{imageId}.{ext}
  const segments = key.split('/');
  const fileName = segments[segments.length - 1];
  const imageId = fileName.split('.')[0];

  logger.info('Processing image', { imageId, bucket, key });

  // Idempotency check — prevents double-processing on S3 retry/duplicate events
  const idempotencyKey = `${bucket}::${key}::${etag}`;
  const acquired = await acquireIdempotencyLock(idempotencyKey);
  if (!acquired) {
    logger.info('Duplicate S3 event detected — skipping', { imageId, idempotencyKey });
    return;
  }

  const table = IMAGE_METADATA_TABLE();

  await updateImageStatus(table, imageId, { status: 'PROCESSING', processingStartTime: new Date().toISOString() });

  try {
    // Step 1: Fetch object metadata for hash-based duplicate detection
    let imageHash: string;
    let headData: any;

    try {
      headData = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      imageHash = calculateS3KeyHash(bucket, key, headData.ETag?.replace(/"/g, ''));
    } catch (err) {
      throw Object.assign(new Error(`S3 HeadObject failed: ${err}`), { name: 'S3_READ_ERROR' });
    }

    // Step 2: Duplicate content detection via imageHash GSI
    if (ENABLE_DUPLICATE) {
      const ddb = getDDBClient();
      const existing = await ddb.send(new QueryCommand({
        TableName: table,
        IndexName: 'imageHash-index',
        KeyConditionExpression: 'imageHash = :h',
        FilterExpression: '#s = :processed',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':h': imageHash, ':processed': 'PROCESSED' },
        Limit: 1,
      }));

      if ((existing.Count ?? 0) > 0) {
        const original = existing.Items![0];
        logger.info('Duplicate content detected', { imageId, originalImageId: original.imageId, imageHash });

        await updateImageStatus(table, imageId, {
          status: 'DUPLICATE',
          imageHash,
          duplicateOf: original.imageId,
          processingEndTime: new Date().toISOString(),
          processingLatencyMs: calculateLatency(processingStart),
          duplicate: true, // triggers CloudWatch metric filter
        });
        return;
      }
    }

    // Step 3: Call Rekognition DetectLabels with retry + jitter
    let labels: LabelResult[];
    let rekognitionModelVersion: string;

    const detectLabelsResult = await withRetry(async () => {
      return rekClient.send(new DetectLabelsCommand({
        Image: { S3Object: { Bucket: bucket, Name: key } },
        MaxLabels: MAX_LABELS,
        MinConfidence: MIN_CONFIDENCE,
        Features: ['GENERAL_LABELS', 'IMAGE_PROPERTIES'],
      }));
    }, 3, 200);

    labels = parseRekognitionLabels(detectLabelsResult.Labels ?? []);
    rekognitionModelVersion = detectLabelsResult.LabelModelVersion ?? 'unknown';

    // Step 4: Write results to DynamoDB with conditional update
    // Only writes if status is still PROCESSING (guards against concurrent executions)
    const processingEnd = Date.now();
    const latencyMs = processingEnd - processingStart;

    const dominantLabel = getDominantLabel(labels);
    const confidenceScore = labels.length > 0
      ? Math.max(...labels.map((l) => l.confidence))
      : 0;

    const confidenceSummary = labels.reduce((acc, l) => {
      acc[l.name] = l.confidence;
      return acc;
    }, {} as Record<string, number>);

    await updateImageStatus(table, imageId, {
      status: 'PROCESSED',
      imageHash,
      labels: labels.map((l) => l.name),
      labelDetails: labels,
      dominantLabel,
      confidenceScore,
      confidenceSummary,
      detectedObjectCount: labels.filter((l) => l.hasBoundingBox).length,
      rekognitionModelVersion,
      processingEndTime: new Date(processingEnd).toISOString(),
      processingLatencyMs: latencyMs,
      imageWidth: detectLabelsResult.ImageProperties?.Quality?.Sharpness,
      coldStart: isCold,
    });

    logger.info('Image processed successfully', {
      imageId,
      labelCount: labels.length,
      dominantLabel,
      confidenceScore,
      latencyMs,
      coldStart: isCold,
    });
  } catch (err) {
    const errorType = classifyError(err);
    const errorMessage = err instanceof Error ? err.message : String(err);

    logger.error('Processing failed', { imageId, errorType, error: errorMessage });

    // Get current retry count from DynamoDB
    const ddb = getDDBClient();
    let retryCount = 0;
    try {
      const current = await ddb.send(new GetCommand({ TableName: table, Key: { imageId } }));
      retryCount = (current.Item?.retryCount ?? 0) + 1;
    } catch { /* use 0 if fetch fails */ }

    await updateImageStatus(table, imageId, {
      status: 'FAILED',
      errorType,
      errorMessage,
      retryCount,
      processingEndTime: new Date().toISOString(),
      processingLatencyMs: calculateLatency(processingStart),
    });

    // Send to DLQ for offline replay
    await sendToDlq(DLQ_URL(), {
      imageId,
      bucket,
      key,
      etag,
      errorType,
      errorMessage,
      retryCount,
      failedAt: new Date().toISOString(),
    }, { errorType, imageId });

    // Re-throw so Lambda marks this record as failed (triggers built-in DLQ on function)
    throw err;
  }
}
