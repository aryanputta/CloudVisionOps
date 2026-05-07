import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

interface LambdaStackProps extends cdk.StackProps {
  stage: string;
  uploadBucket: s3.Bucket;
  imageMetadataTable: dynamodb.Table;
  opsRecommendationsTable: dynamodb.Table;
  agentRunsTable: dynamodb.Table;
  dlq: sqs.Queue;
  processingQueue: sqs.Queue;
  alertTopic: sns.Topic;
}

const LAMBDA_ROOT = path.join(__dirname, '../../../backend/lambdas');

function sharedEnv(props: LambdaStackProps): Record<string, string> {
  return {
    IMAGE_METADATA_TABLE: props.imageMetadataTable.tableName,
    OPS_RECOMMENDATIONS_TABLE: props.opsRecommendationsTable.tableName,
    AGENT_RUNS_TABLE: props.agentRunsTable.tableName,
    UPLOAD_BUCKET: props.uploadBucket.bucketName,
    DLQ_URL: props.dlq.queueUrl,
    PROCESSING_QUEUE_URL: props.processingQueue.queueUrl,
    ALERT_TOPIC_ARN: props.alertTopic.topicArn,
    STAGE: props.stage,
    POWERTOOLS_SERVICE_NAME: 'CloudVisionOps',
    LOG_LEVEL: props.stage === 'prod' ? 'INFO' : 'DEBUG',
    REKOGNITION_MAX_LABELS: '20',
    REKOGNITION_MIN_CONFIDENCE: '70',
    ENABLE_DUPLICATE_DETECTION: 'true',
    ENABLE_XRAY: 'true',
  };
}

export class LambdaStack extends cdk.Stack {
  public readonly uploadUrlHandler: lambda.Function;
  public readonly rekognitionProcessor: lambda.Function;
  public readonly metadataQueryHandler: lambda.Function;
  public readonly analyticsAggregator: lambda.Function;
  public readonly failureMonitor: lambda.Function;
  public readonly dlqReplay: lambda.Function;
  public readonly opsAgent: lambda.Function;
  public readonly agenticOps: lambda.Function;

  constructor(scope: Construct, id: string, props: LambdaStackProps) {
    super(scope, id, props);

    const { stage, uploadBucket, imageMetadataTable, opsRecommendationsTable, agentRunsTable, dlq, processingQueue, alertTopic } = props;

    // Shared Lambda layer for utilities
    const utilsLayer = new lambda.LayerVersion(this, 'UtilsLayer', {
      layerVersionName: `CloudVisionOps-Utils-${stage}`,
      code: lambda.Code.fromAsset(path.join(__dirname, '../../../backend/shared')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'Shared utilities: logger, error types, DynamoDB helpers',
    });

    // Upload URL Handler — generates pre-signed S3 URLs for direct browser uploads
    this.uploadUrlHandler = new lambdaNodejs.NodejsFunction(this, 'UploadUrlHandler', {
      functionName: `CloudVisionOps-UploadUrlHandler-${stage}`,
      entry: path.join(LAMBDA_ROOT, 'upload-url-handler/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        ...sharedEnv(props),
        PRESIGNED_URL_EXPIRY_SECONDS: '300',
        MAX_FILE_SIZE_BYTES: '10485760', // 10 MB
        ALLOWED_CONTENT_TYPES: 'image/jpeg,image/png',
      },
      layers: [utilsLayer],
      logRetention: logs.RetentionDays.ONE_MONTH,
      tracing: lambda.Tracing.ACTIVE,
      bundling: { minify: true, sourceMap: true },
    });

    uploadBucket.grantPut(this.uploadUrlHandler);
    imageMetadataTable.grantWriteData(this.uploadUrlHandler);

    // Rekognition Processor — container image Lambda.
    // OCI image eliminates node_modules cold-start load time: AWS SDKs are pre-installed
    // in the base image and externalized from the bundle, so the only payload is the
    // compiled business logic (~50KB). Build context is backend/ so the Dockerfile
    // can reach shared/utils.ts without copying it into the lambda directory.
    this.rekognitionProcessor = new lambda.DockerImageFunction(this, 'RekognitionProcessor', {
      functionName: `CloudVisionOps-RekognitionProcessor-${stage}`,
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../../../backend'),
        { file: 'lambdas/rekognition-processor/Dockerfile' }
      ),
      memorySize: 1024,
      timeout: cdk.Duration.seconds(60),
      environment: {
        ...sharedEnv(props),
        IDEMPOTENCY_TABLE: `CloudVisionOps-Idempotency-${stage}`,
        CIRCUIT_BREAKER_TABLE: `CloudVisionOps-Idempotency-${stage}`,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      tracing: lambda.Tracing.ACTIVE,
      reservedConcurrentExecutions: 50,
      deadLetterQueue: dlq,
    });

    uploadBucket.grantRead(this.rekognitionProcessor);
    imageMetadataTable.grantReadWriteData(this.rekognitionProcessor);
    dlq.grantSendMessages(this.rekognitionProcessor);

    this.rekognitionProcessor.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['rekognition:DetectLabels', 'rekognition:DetectModerationLabels'],
      resources: ['*'],
    }));

    this.rekognitionProcessor.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/CloudVisionOps-Idempotency-${stage}`],
    }));

    // Wire S3 events directly to processor Lambda
    uploadBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.rekognitionProcessor),
      { suffix: '.jpg' }
    );
    uploadBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.rekognitionProcessor),
      { suffix: '.jpeg' }
    );
    uploadBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.rekognitionProcessor),
      { suffix: '.png' }
    );

    // Metadata Query Handler — API read path for frontend
    this.metadataQueryHandler = new lambdaNodejs.NodejsFunction(this, 'MetadataQueryHandler', {
      functionName: `CloudVisionOps-MetadataQuery-${stage}`,
      entry: path.join(LAMBDA_ROOT, 'metadata-writer/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      environment: sharedEnv(props),
      layers: [utilsLayer],
      logRetention: logs.RetentionDays.ONE_MONTH,
      tracing: lambda.Tracing.ACTIVE,
      bundling: { minify: true, sourceMap: true },
    });

    imageMetadataTable.grantReadData(this.metadataQueryHandler);
    agentRunsTable.grantReadData(this.metadataQueryHandler);

    // Analytics Aggregator — triggered by EventBridge Pipes on DynamoDB Stream events
    this.analyticsAggregator = new lambdaNodejs.NodejsFunction(this, 'AnalyticsAggregator', {
      functionName: `CloudVisionOps-AnalyticsAggregator-${stage}`,
      entry: path.join(LAMBDA_ROOT, 'analytics-aggregator/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: sharedEnv(props),
      layers: [utilsLayer],
      logRetention: logs.RetentionDays.ONE_MONTH,
      tracing: lambda.Tracing.ACTIVE,
      bundling: { minify: true, sourceMap: true },
    });

    imageMetadataTable.grantReadWriteData(this.analyticsAggregator);
    alertTopic.grantPublish(this.analyticsAggregator);

    // Failure Monitor — reacts to FAILED stream events, escalates via SNS
    this.failureMonitor = new lambdaNodejs.NodejsFunction(this, 'FailureMonitor', {
      functionName: `CloudVisionOps-FailureMonitor-${stage}`,
      entry: path.join(LAMBDA_ROOT, 'failure-monitor/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: sharedEnv(props),
      layers: [utilsLayer],
      logRetention: logs.RetentionDays.ONE_MONTH,
      tracing: lambda.Tracing.ACTIVE,
      bundling: { minify: true, sourceMap: true },
    });

    imageMetadataTable.grantReadWriteData(this.failureMonitor);
    alertTopic.grantPublish(this.failureMonitor);
    dlq.grantSendMessages(this.failureMonitor);

    // DLQ Replay — reads from DLQ and reprocesses failed jobs with traceability
    this.dlqReplay = new lambdaNodejs.NodejsFunction(this, 'DlqReplay', {
      functionName: `CloudVisionOps-DLQReplay-${stage}`,
      entry: path.join(LAMBDA_ROOT, 'dlq-replay/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: cdk.Duration.seconds(120),
      environment: {
        ...sharedEnv(props),
        MAX_REPLAY_BATCH: '10',
        REPLAY_DELAY_MS: '1000',
      },
      layers: [utilsLayer],
      logRetention: logs.RetentionDays.ONE_MONTH,
      tracing: lambda.Tracing.ACTIVE,
      bundling: { minify: true, sourceMap: true },
    });

    dlq.grantConsumeMessages(this.dlqReplay);
    uploadBucket.grantRead(this.dlqReplay);
    imageMetadataTable.grantReadWriteData(this.dlqReplay);
    this.dlqReplay.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['rekognition:DetectLabels'],
      resources: ['*'],
    }));

    // Ops Agent — Python autonomous operations analyzer
    this.opsAgent = new lambda.Function(this, 'OpsAgent', {
      functionName: `CloudVisionOps-OpsAgent-${stage}`,
      code: lambda.Code.fromAsset(path.join(LAMBDA_ROOT, 'ops-agent')),
      handler: 'index.handler',
      runtime: lambda.Runtime.PYTHON_3_12,
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      environment: {
        ...sharedEnv(props),
        LATENCY_SPIKE_THRESHOLD_MS: '5000',
        HIGH_FAILURE_RATE_THRESHOLD: '0.05',
        DLQ_BACKLOG_THRESHOLD: '50',
        DUPLICATE_SURGE_THRESHOLD: '0.30',
        LOW_CONFIDENCE_THRESHOLD: '75',
        COST_SPIKE_THRESHOLD_PERCENT: '20',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      tracing: lambda.Tracing.ACTIVE,
    });

    imageMetadataTable.grantReadData(this.opsAgent);
    opsRecommendationsTable.grantReadWriteData(this.opsAgent);
    dlq.grantConsumeMessages(this.opsAgent);
    this.opsAgent.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:GetMetricStatistics', 'cloudwatch:ListMetrics', 'cloudwatch:GetMetricData'],
      resources: ['*'],
    }));
    alertTopic.grantPublish(this.opsAgent);

    // CloudWatch event to run Ops Agent every 15 minutes
    const rule = new cdk.aws_events.Rule(this, 'OpsAgentSchedule', {
      ruleName: `CloudVisionOps-OpsAgentSchedule-${stage}`,
      schedule: cdk.aws_events.Schedule.rate(cdk.Duration.minutes(15)),
    });
    rule.addTarget(new cdk.aws_events_targets.LambdaFunction(this.opsAgent));

    // Agentic Ops — Claude API ReAct loop for autonomous reasoning and diagnosis
    // Runs hourly on a separate schedule from the deterministic rule-based ops agent.
    // Higher timeout (10 min) to accommodate multi-turn Claude API calls.
    this.agenticOps = new lambda.Function(this, 'AgenticOps', {
      functionName: `CloudVisionOps-AgenticOps-${stage}`,
      code: lambda.Code.fromAsset(path.join(LAMBDA_ROOT, 'agentic-ops'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output',
          ],
        },
      }),
      handler: 'agent.handler',
      runtime: lambda.Runtime.PYTHON_3_12,
      memorySize: 512,
      timeout: cdk.Duration.minutes(10),
      environment: {
        ...sharedEnv(props),
        AGENT_RUNS_TABLE: agentRunsTable.tableName,
        // ANTHROPIC_API_KEY read from SSM at runtime — not hardcoded here
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      tracing: lambda.Tracing.ACTIVE,
    });

    imageMetadataTable.grantReadData(this.agenticOps);
    opsRecommendationsTable.grantReadWriteData(this.agenticOps);
    agentRunsTable.grantReadWriteData(this.agenticOps);
    dlq.grantConsumeMessages(this.agenticOps);
    alertTopic.grantPublish(this.agenticOps);

    this.agenticOps.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:GetMetricStatistics', 'cloudwatch:ListMetrics'],
      resources: ['*'],
    }));

    // Auto-remediation: agent can read and set concurrency on the processor only
    this.agenticOps.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:GetFunctionConcurrency', 'lambda:PutFunctionConcurrency'],
      resources: [this.rekognitionProcessor.functionArn],
    }));

    // Read ANTHROPIC_API_KEY from SSM Parameter Store at deploy time
    // Parameter must be created manually: aws ssm put-parameter --name /cloudvisionops/anthropic-api-key --type SecureString --value <key>
    this.agenticOps.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/cloudvisionops/anthropic-api-key`],
    }));

    // Run agentic ops hourly — independent cadence from the 15-minute deterministic agent
    const agenticRule = new cdk.aws_events.Rule(this, 'AgenticOpsSchedule', {
      ruleName: `CloudVisionOps-AgenticOpsSchedule-${stage}`,
      schedule: cdk.aws_events.Schedule.rate(cdk.Duration.hours(1)),
    });
    agenticRule.addTarget(new cdk.aws_events_targets.LambdaFunction(this.agenticOps));

    // Outputs
    [
      ['UploadUrlHandlerArn', this.uploadUrlHandler.functionArn],
      ['RekognitionProcessorArn', this.rekognitionProcessor.functionArn],
      ['MetadataQueryHandlerArn', this.metadataQueryHandler.functionArn],
      ['AnalyticsAggregatorArn', this.analyticsAggregator.functionArn],
      ['FailureMonitorArn', this.failureMonitor.functionArn],
      ['DlqReplayArn', this.dlqReplay.functionArn],
      ['OpsAgentArn', this.opsAgent.functionArn],
      ['AgenticOpsArn', this.agenticOps.functionArn],
    ].forEach(([name, value]) => {
      new cdk.CfnOutput(this, name, { value, exportName: `${id}-${name}` });
    });
  }
}
