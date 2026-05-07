/**
 * Step Functions Express workflow for auditable image processing.
 *
 * WHY THIS IS NOT THE PRIMARY PATH:
 * The main pipeline (S3 → Lambda → Rekognition → DynamoDB) handles the
 * high-volume path. Step Functions is deliberately kept as a secondary path
 * for "premium" jobs that require a full audit trail.
 *
 * The decision not to route everything through Step Functions was intentional:
 *
 * 1. Cost: Express workflows bill per state transition at $1.00/million.
 *    The primary path has 3 states per image × 1M images = $3.00 overhead
 *    vs $0.20 for Lambda direct invocations. 15x cost increase for no throughput gain.
 *
 * 2. Latency: Step Functions adds ~100ms overhead per state transition for
 *    the control plane round trip. Over 3 states = ~300ms added to every image.
 *    At p50 = 1,760ms, that is a 17% latency increase for no reliability gain
 *    — the Lambda DLQ already handles failures.
 *
 * 3. The primary path already has an explicit state machine — it's just in
 *    DynamoDB (PENDING → PROCESSING → PROCESSED/FAILED) rather than in
 *    Step Functions. DynamoDB Streams + EventBridge Pipes give the same
 *    event-driven transitions at lower cost and latency.
 *
 * WHEN STEP FUNCTIONS IS THE RIGHT CHOICE HERE:
 * - Compliance workloads requiring immutable audit trail of every state change
 * - Branching on Rekognition output (e.g., if Person detected → trigger moderation flow)
 * - Human-in-the-loop review (waitForCallback pattern)
 * - Parallel processing across multiple Rekognition feature types with fan-out/join
 */

import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface StepFunctionsStackProps extends cdk.StackProps {
  stage: string;
  rekognitionProcessor: lambda.Function;
  imageMetadataTable: dynamodb.Table;
}

export class StepFunctionsStack extends cdk.Stack {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: StepFunctionsStackProps) {
    super(scope, id, props);

    const { stage, rekognitionProcessor, imageMetadataTable } = props;

    const logGroup = new logs.LogGroup(this, 'SFNLogGroup', {
      logGroupName: `/aws/states/CloudVisionOps-ImageProcessing-${stage}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // State: Mark image as PROCESSING in DynamoDB
    const markProcessing = new tasks.DynamoUpdateItem(this, 'MarkProcessing', {
      table: imageMetadataTable,
      key: {
        imageId: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt('$.imageId')
        ),
      },
      updateExpression: 'SET #s = :processing, processingStartTime = :ts, updatedAt = :ts',
      expressionAttributeNames: { '#s': 'status' },
      expressionAttributeValues: {
        ':processing': tasks.DynamoAttributeValue.fromString('PROCESSING'),
        ':ts': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.Execution.StartTime')),
      },
      resultPath: sfn.JsonPath.DISCARD,
    });

    // State: Call Rekognition Processor Lambda
    const callProcessor = new tasks.LambdaInvoke(this, 'CallRekognitionProcessor', {
      lambdaFunction: rekognitionProcessor,
      payload: sfn.TaskInput.fromObject({
        'source': 'STEP_FUNCTIONS',
        'imageId.$': '$.imageId',
        'bucket.$': '$.bucket',
        'key.$': '$.key',
      }),
      retryOnServiceExceptions: true,
      resultPath: '$.processorResult',
    });

    // Step Functions built-in retry with exponential backoff (Amazon Leadership Principle: Ownership)
    callProcessor.addRetry({
      errors: ['Lambda.ServiceException', 'Lambda.AWSLambdaException', 'Lambda.TooManyRequestsException'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2,
      jitterStrategy: sfn.JitterType.FULL,
    });

    callProcessor.addCatch(new sfn.Pass(this, 'CaptureProcessingError', {
      parameters: {
        'imageId.$': '$.imageId',
        'errorType': 'STEP_FUNCTIONS_ERROR',
        'error.$': '$.processorResult.Error',
        'cause.$': '$.processorResult.Cause',
      },
    }).next(
      new tasks.DynamoUpdateItem(this, 'MarkFailed', {
        table: imageMetadataTable,
        key: {
          imageId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.imageId')),
        },
        updateExpression: 'SET #s = :failed, errorType = :et, errorMessage = :em, updatedAt = :ts',
        expressionAttributeNames: { '#s': 'status' },
        expressionAttributeValues: {
          ':failed': tasks.DynamoAttributeValue.fromString('FAILED'),
          ':et': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.errorType')),
          ':em': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.cause')),
          ':ts': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.State.EnteredTime')),
        },
        resultPath: sfn.JsonPath.DISCARD,
      })
    ), { resultPath: '$.error' });

    // State: Mark image as PROCESSED
    const markProcessed = new tasks.DynamoUpdateItem(this, 'MarkProcessed', {
      table: imageMetadataTable,
      key: {
        imageId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.imageId')),
      },
      updateExpression: 'SET #s = :processed, processingEndTime = :ts, updatedAt = :ts',
      expressionAttributeNames: { '#s': 'status' },
      expressionAttributeValues: {
        ':processed': tasks.DynamoAttributeValue.fromString('PROCESSED'),
        ':ts': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.State.EnteredTime')),
      },
      resultPath: sfn.JsonPath.DISCARD,
    });

    // Chain: mark processing → call processor → mark processed
    const definition = markProcessing
      .next(callProcessor)
      .next(markProcessed);

    this.stateMachine = new sfn.StateMachine(this, 'ImageProcessingStateMachine', {
      stateMachineName: `CloudVisionOps-ImageProcessing-${stage}`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.EXPRESS,  // Express for high-throughput, per-execution billing
      timeout: cdk.Duration.minutes(5),
      tracingEnabled: true,  // X-Ray traces every state transition
      logs: {
        destination: logGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
    });

    imageMetadataTable.grantReadWriteData(this.stateMachine);

    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: this.stateMachine.stateMachineArn,
      exportName: `${id}-StateMachineArn`,
    });
  }
}
