import { DynamoDBStreamEvent } from 'aws-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { AttributeValue } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  createLogger,
  getEnvVar,
  getDDBClient,
  sendToDlq,
} from '../../shared/utils';

const logger = createLogger('FailureMonitor');
const sns = new SNSClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

const TABLE = () => getEnvVar('IMAGE_METADATA_TABLE');
const ALERT_TOPIC = () => getEnvVar('ALERT_TOPIC_ARN');
const DLQ = () => getEnvVar('DLQ_URL');

// Sliding window: fire alert if failure rate > threshold in the last N records
const FAILURE_RATE_THRESHOLD = parseFloat(process.env.HIGH_FAILURE_RATE_THRESHOLD ?? '0.05');
const FAILURE_WINDOW_SIZE = 100;

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  logger.info('Failure monitor triggered', { recordCount: event.Records.length });

  const failedItems: any[] = [];

  for (const record of event.Records) {
    if (!record.dynamodb?.NewImage) continue;

    const item = unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>);

    if (item.status === 'FAILED') {
      failedItems.push(item);
      logger.warn('Failed image detected', {
        imageId: item.imageId,
        errorType: item.errorType,
        retryCount: item.retryCount,
        errorMessage: item.errorMessage,
      });
    }
  }

  if (failedItems.length === 0) return;

  // Check recent failure rate to decide whether to escalate
  const recentFailureRate = await getRecentFailureRate(getDDBClient(), TABLE());

  const highRetryItems = failedItems.filter((i) => (i.retryCount ?? 0) > 2);

  // Escalate if failure rate is high or any item has exceeded retry budget
  const shouldAlert = recentFailureRate > FAILURE_RATE_THRESHOLD || highRetryItems.length > 0;

  if (shouldAlert) {
    await sns.send(new PublishCommand({
      TopicArn: ALERT_TOPIC(),
      Subject: `[CloudVisionOps] HIGH FAILURE RATE ALERT`,
      Message: JSON.stringify({
        event: 'HIGH_FAILURE_RATE',
        failureRate: recentFailureRate,
        threshold: FAILURE_RATE_THRESHOLD,
        failedCount: failedItems.length,
        highRetryCount: highRetryItems.length,
        samples: failedItems.slice(0, 5).map((i) => ({
          imageId: i.imageId,
          errorType: i.errorType,
          retryCount: i.retryCount,
        })),
        timestamp: new Date().toISOString(),
      }),
      MessageAttributes: {
        eventType: { DataType: 'String', StringValue: 'HIGH_FAILURE_RATE' },
        severity: { DataType: 'String', StringValue: 'HIGH' },
      },
    }));

    logger.warn('Failure rate alert published', { recentFailureRate, failedCount: failedItems.length });
  }

  // Send permanently-failed jobs (retryCount > 2) to DLQ for manual replay
  for (const item of highRetryItems) {
    await sendToDlq(DLQ(), {
      imageId: item.imageId,
      errorType: item.errorType,
      errorMessage: item.errorMessage,
      retryCount: item.retryCount,
      bucket: item.bucketName,
      key: item.objectKey,
      quarantined: true,
      quarantinedAt: new Date().toISOString(),
    }, { imageId: item.imageId, errorType: item.errorType ?? 'UNKNOWN' });
  }
};

async function getRecentFailureRate(ddb: DynamoDBDocumentClient, table: string): Promise<number> {
  try {
    const [failedResult, processedResult] = await Promise.all([
      ddb.send(new QueryCommand({
        TableName: table,
        IndexName: 'status-updatedAt-index',
        KeyConditionExpression: '#s = :status',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':status': 'FAILED' },
        ScanIndexForward: false,
        Limit: FAILURE_WINDOW_SIZE,
        Select: 'COUNT',
      })),
      ddb.send(new QueryCommand({
        TableName: table,
        IndexName: 'status-updatedAt-index',
        KeyConditionExpression: '#s = :status',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':status': 'PROCESSED' },
        ScanIndexForward: false,
        Limit: FAILURE_WINDOW_SIZE,
        Select: 'COUNT',
      })),
    ]);

    const failed = failedResult.Count ?? 0;
    const processed = processedResult.Count ?? 0;
    const total = failed + processed;

    return total > 0 ? failed / total : 0;
  } catch (err) {
    logger.error('Failed to compute failure rate', { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}
