import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { RekognitionClient, DetectLabelsCommand } from '@aws-sdk/client-rekognition';
import {
  getEnvVar,
  createLogger,
  getDDBClient,
  updateImageStatus,
  calculateLatency,
  parseRekognitionLabels,
  getDominantLabel,
  acquireIdempotencyLock,
  withRetry,
  apiResponse,
} from '../../shared/utils';

const logger = createLogger('DLQReplay');

const sqsClient = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const s3Client = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const rekClient = new RekognitionClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

const MAX_BATCH = parseInt(process.env.MAX_REPLAY_BATCH ?? '10', 10);
const REPLAY_DELAY = parseInt(process.env.REPLAY_DELAY_MS ?? '1000', 10);

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const dlqUrl = getEnvVar('DLQ_URL');
  const table = getEnvVar('IMAGE_METADATA_TABLE');

  logger.info('DLQ replay started', { maxBatch: MAX_BATCH });

  const messages = await sqsClient.send(new ReceiveMessageCommand({
    QueueUrl: dlqUrl,
    MaxNumberOfMessages: Math.min(MAX_BATCH, 10),
    WaitTimeSeconds: 5,
    MessageAttributeNames: ['All'],
  }));

  if (!messages.Messages || messages.Messages.length === 0) {
    return apiResponse(200, { replayed: 0, message: 'DLQ is empty' });
  }

  const results: Array<{ imageId: string; success: boolean; error?: string }> = [];

  for (const msg of messages.Messages) {
    let body: any;
    try {
      body = JSON.parse(msg.Body ?? '{}');
    } catch {
      logger.warn('Invalid DLQ message body', { messageId: msg.MessageId });
      continue;
    }

    const { imageId, bucket, key, retryCount = 0 } = body;

    // Replay idempotency: skip if already replayed recently
    const replayKey = `replay::${imageId}::${retryCount}`;
    const acquired = await acquireIdempotencyLock(replayKey, 3600);
    if (!acquired) {
      logger.info('Replay already in progress or completed', { imageId, replayKey });
      continue;
    }

    const startMs = Date.now();
    let success = false;

    try {
      // Verify the S3 object still exists before replaying
      await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));

      // Re-run Rekognition with retry
      const labelsResult = await withRetry(
        () => rekClient.send(new DetectLabelsCommand({
          Image: { S3Object: { Bucket: bucket, Name: key } },
          MaxLabels: 20,
          MinConfidence: 70,
        })),
        3,
        500
      );

      const labels = parseRekognitionLabels(labelsResult.Labels ?? []);
      const dominantLabel = getDominantLabel(labels);
      const confidenceScore = labels.length > 0 ? Math.max(...labels.map((l) => l.confidence)) : 0;

      await updateImageStatus(table, imageId, {
        status: 'PROCESSED',
        labels: labels.map((l) => l.name),
        labelDetails: labels,
        dominantLabel,
        confidenceScore,
        confidenceSummary: Object.fromEntries(labels.map((l) => [l.name, l.confidence])),
        processingLatencyMs: calculateLatency(startMs),
        processingEndTime: new Date().toISOString(),
        retryCount: retryCount + 1,
        replayedAt: new Date().toISOString(),
        // Traceability: record that this was a replayed job
        replaySource: 'DLQ_REPLAY',
        replayBatch: new Date().toISOString().split('T')[0],
      });

      // Delete from DLQ only after successful processing
      await sqsClient.send(new DeleteMessageCommand({
        QueueUrl: dlqUrl,
        ReceiptHandle: msg.ReceiptHandle!,
      }));

      success = true;
      logger.info('DLQ replay succeeded', { imageId, latencyMs: calculateLatency(startMs) });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('DLQ replay failed', { imageId, error: errorMessage, retryCount });

      await updateImageStatus(table, imageId, {
        status: 'FAILED',
        errorMessage,
        retryCount: retryCount + 1,
        lastReplayAttempt: new Date().toISOString(),
      });
    }

    results.push({ imageId, success });

    // Delay between replays to avoid thundering herd on Rekognition
    if (REPLAY_DELAY > 0) {
      await new Promise((resolve) => setTimeout(resolve, REPLAY_DELAY));
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  logger.info('DLQ replay complete', { total: results.length, succeeded, failed });

  return apiResponse(200, {
    replayed: results.length,
    succeeded,
    failed,
    results,
  });
};
