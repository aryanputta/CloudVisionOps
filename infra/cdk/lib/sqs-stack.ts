import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

interface SqsStackProps extends cdk.StackProps {
  stage: string;
}

export class SqsStack extends cdk.Stack {
  public readonly dlq: sqs.Queue;
  public readonly processingQueue: sqs.Queue;
  public readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: SqsStackProps) {
    super(scope, id, props);

    const { stage } = props;

    // Dead Letter Queue: catches all permanently-failed processing jobs
    // Visibility timeout must be >= processor queue visibility timeout
    this.dlq = new sqs.Queue(this, 'ProcessingDLQ', {
      queueName: `CloudVisionOps-DLQ-${stage}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(300),
    });

    // Main processing queue: FIFO ensures ordered, exactly-once delivery
    // Uses content-based deduplication to deduplicate duplicate S3 events
    this.processingQueue = new sqs.Queue(this, 'ProcessingQueue', {
      queueName: `CloudVisionOps-Processing-${stage}.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(300),
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: this.dlq,
        maxReceiveCount: 3, // 3 retries before DLQ
      },
    });

    // SNS alert topic for operational events — fan-out to email, PagerDuty, Slack
    this.alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: `CloudVisionOps-Alerts-${stage}`,
      displayName: 'CloudVisionOps Operational Alerts',
    });

    // DLQ alarm notification subscription
    this.alertTopic.addSubscription(
      new snsSubscriptions.SqsSubscription(
        new sqs.Queue(this, 'AlertDeadLetter', {
          queueName: `CloudVisionOps-AlertDLQ-${stage}`,
          retentionPeriod: cdk.Duration.days(7),
        }),
        { rawMessageDelivery: true }
      )
    );

    new cdk.CfnOutput(this, 'DLQUrl', {
      value: this.dlq.queueUrl,
      exportName: `${id}-DLQUrl`,
    });

    new cdk.CfnOutput(this, 'DLQArn', {
      value: this.dlq.queueArn,
      exportName: `${id}-DLQArn`,
    });

    new cdk.CfnOutput(this, 'ProcessingQueueUrl', {
      value: this.processingQueue.queueUrl,
      exportName: `${id}-ProcessingQueueUrl`,
    });

    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: this.alertTopic.topicArn,
      exportName: `${id}-AlertTopicArn`,
    });
  }
}
