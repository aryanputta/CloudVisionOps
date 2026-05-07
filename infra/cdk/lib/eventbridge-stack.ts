import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import { Construct } from 'constructs';

interface EventBridgeStackProps extends cdk.StackProps {
  stage: string;
  imageMetadataTable: dynamodb.Table;
  analyticsAggregator: lambda.Function;
  failureMonitor: lambda.Function;
  dlq: sqs.Queue;
}

export class EventBridgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EventBridgeStackProps) {
    super(scope, id, props);

    const { stage, imageMetadataTable, analyticsAggregator, failureMonitor, dlq } = props;

    // IAM role for EventBridge Pipes — needs to read the DynamoDB stream and invoke Lambda
    const pipeRole = new iam.Role(this, 'PipeRole', {
      roleName: `CloudVisionOps-PipeRole-${stage}`,
      assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com'),
    });

    imageMetadataTable.grantStreamRead(pipeRole);
    analyticsAggregator.grantInvoke(pipeRole);
    failureMonitor.grantInvoke(pipeRole);
    dlq.grantSendMessages(pipeRole);

    // Pipe 1: PROCESSED events -> Analytics Aggregator
    // Filters for only newly-PROCESSED records to avoid noise from updates
    new pipes.CfnPipe(this, 'ProcessedEventsPipe', {
      name: `CloudVisionOps-ProcessedPipe-${stage}`,
      roleArn: pipeRole.roleArn,
      source: imageMetadataTable.tableStreamArn!,
      sourceParameters: {
        dynamoDbStreamParameters: {
          startingPosition: 'LATEST',
          batchSize: 10,
          maximumBatchingWindowInSeconds: 5,
          maximumRetryAttempts: 3,
          deadLetterConfig: { arn: dlq.queueArn },
        },
        filterCriteria: {
          filters: [
            {
              // Pass only INSERT or MODIFY events where new image status = PROCESSED
              pattern: JSON.stringify({
                eventName: ['INSERT', 'MODIFY'],
                dynamodb: {
                  NewImage: {
                    status: { S: ['PROCESSED'] },
                  },
                },
              }),
            },
          ],
        },
      },
      target: analyticsAggregator.functionArn,
      targetParameters: {
        lambdaFunctionParameters: {
          invocationType: 'FIRE_AND_FORGET',
        },
      },
    });

    // Pipe 2: FAILED events -> Failure Monitor
    new pipes.CfnPipe(this, 'FailedEventsPipe', {
      name: `CloudVisionOps-FailedPipe-${stage}`,
      roleArn: pipeRole.roleArn,
      source: imageMetadataTable.tableStreamArn!,
      sourceParameters: {
        dynamoDbStreamParameters: {
          startingPosition: 'LATEST',
          batchSize: 5,
          maximumBatchingWindowInSeconds: 10,
          maximumRetryAttempts: 2,
          deadLetterConfig: { arn: dlq.queueArn },
        },
        filterCriteria: {
          filters: [
            {
              pattern: JSON.stringify({
                eventName: ['INSERT', 'MODIFY'],
                dynamodb: {
                  NewImage: {
                    status: { S: ['FAILED'] },
                  },
                },
              }),
            },
          ],
        },
      },
      target: failureMonitor.functionArn,
      targetParameters: {
        lambdaFunctionParameters: {
          invocationType: 'FIRE_AND_FORGET',
        },
      },
    });

    // Pipe 3: Low-confidence labels -> Analytics (confidence < threshold)
    new pipes.CfnPipe(this, 'LowConfidencePipe', {
      name: `CloudVisionOps-LowConfidencePipe-${stage}`,
      roleArn: pipeRole.roleArn,
      source: imageMetadataTable.tableStreamArn!,
      sourceParameters: {
        dynamoDbStreamParameters: {
          startingPosition: 'LATEST',
          batchSize: 10,
          maximumBatchingWindowInSeconds: 30,
          maximumRetryAttempts: 2,
          deadLetterConfig: { arn: dlq.queueArn },
        },
        filterCriteria: {
          filters: [
            {
              pattern: JSON.stringify({
                eventName: ['INSERT'],
                dynamodb: {
                  NewImage: {
                    status: { S: ['PROCESSED'] },
                    confidenceScore: { N: [{ numeric: ['<', 75] }] },
                  },
                },
              }),
            },
          ],
        },
      },
      target: analyticsAggregator.functionArn,
      targetParameters: {
        lambdaFunctionParameters: {
          invocationType: 'FIRE_AND_FORGET',
        },
      },
    });

    // Pipe 4: High retry count events -> DLQ directly (gives up on stuck jobs)
    new pipes.CfnPipe(this, 'HighRetryPipe', {
      name: `CloudVisionOps-HighRetryPipe-${stage}`,
      roleArn: pipeRole.roleArn,
      source: imageMetadataTable.tableStreamArn!,
      sourceParameters: {
        dynamoDbStreamParameters: {
          startingPosition: 'LATEST',
          batchSize: 5,
          maximumBatchingWindowInSeconds: 60,
          maximumRetryAttempts: 1,
          deadLetterConfig: { arn: dlq.queueArn },
        },
        filterCriteria: {
          filters: [
            {
              pattern: JSON.stringify({
                eventName: ['MODIFY'],
                dynamodb: {
                  NewImage: {
                    retryCount: { N: [{ numeric: ['>', 2] }] },
                  },
                },
              }),
            },
          ],
        },
      },
      target: failureMonitor.functionArn,
      targetParameters: {
        lambdaFunctionParameters: {
          invocationType: 'FIRE_AND_FORGET',
        },
      },
    });
  }
}
