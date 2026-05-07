import { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { AttributeValue } from '@aws-sdk/client-dynamodb';
import { createLogger, getEnvVar } from '../../shared/utils';

const logger = createLogger('AnalyticsAggregator');

const sns = new SNSClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

const ALERT_TOPIC_ARN = () => getEnvVar('ALERT_TOPIC_ARN');

interface ProcessedRecord {
  imageId: string;
  status: string;
  dominantLabel?: string;
  confidenceScore?: number;
  processingLatencyMs?: number;
  retryCount?: number;
  userId?: string;
}

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  logger.info('Analytics aggregator triggered', { recordCount: event.Records.length });

  const processedImages: ProcessedRecord[] = [];
  const lowConfidenceImages: ProcessedRecord[] = [];

  for (const record of event.Records) {
    if (!record.dynamodb?.NewImage) continue;

    const item = unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>) as ProcessedRecord;

    if (item.status === 'PROCESSED') {
      processedImages.push(item);

      if ((item.confidenceScore ?? 100) < 75) {
        lowConfidenceImages.push(item);
      }
    }
  }

  if (processedImages.length > 0) {
    const avgLatency = processedImages
      .filter((i) => i.processingLatencyMs != null)
      .reduce((sum, i) => sum + (i.processingLatencyMs ?? 0), 0) / processedImages.length;

    const labelCounts: Record<string, number> = {};
    processedImages.forEach((img) => {
      if (img.dominantLabel) {
        labelCounts[img.dominantLabel] = (labelCounts[img.dominantLabel] ?? 0) + 1;
      }
    });

    logger.info('Analytics summary', {
      processedCount: processedImages.length,
      avgLatencyMs: Math.round(avgLatency),
      labelDistribution: labelCounts,
      lowConfidenceCount: lowConfidenceImages.length,
    });

    // Publish aggregated analytics event to SNS for downstream consumers
    if (lowConfidenceImages.length > 0) {
      await sns.send(new PublishCommand({
        TopicArn: ALERT_TOPIC_ARN(),
        Subject: `[CloudVisionOps] Low Confidence Labels Detected`,
        Message: JSON.stringify({
          event: 'LOW_CONFIDENCE_LABELS',
          count: lowConfidenceImages.length,
          images: lowConfidenceImages.map((i) => ({
            imageId: i.imageId,
            confidenceScore: i.confidenceScore,
            dominantLabel: i.dominantLabel,
          })),
          timestamp: new Date().toISOString(),
        }),
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: 'LOW_CONFIDENCE_LABELS' },
        },
      }));
    }
  }
};
