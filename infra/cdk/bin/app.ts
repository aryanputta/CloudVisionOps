#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { S3Stack } from '../lib/s3-stack';
import { DynamoDBStack } from '../lib/dynamodb-stack';
import { SqsStack } from '../lib/sqs-stack';
import { CognitoStack } from '../lib/cognito-stack';
import { LambdaStack } from '../lib/lambda-stack';
import { ApiStack } from '../lib/api-stack';
import { EventBridgeStack } from '../lib/eventbridge-stack';
import { MonitoringStack } from '../lib/monitoring-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1',
};

const stage = process.env.ENVIRONMENT || 'dev';
const prefix = `CloudVisionOps-${stage}`;

// Callback URLs: localhost for dev, real domain for prod
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

const s3Stack = new S3Stack(app, `${prefix}-S3`, { env, stage });

const dynamoStack = new DynamoDBStack(app, `${prefix}-DynamoDB`, { env, stage });

const sqsStack = new SqsStack(app, `${prefix}-SQS`, { env, stage });

const cognitoStack = new CognitoStack(app, `${prefix}-Cognito`, {
  env,
  stage,
  callbackUrls: [frontendUrl, `${frontendUrl}/callback`],
  logoutUrls: [frontendUrl],
});

const lambdaStack = new LambdaStack(app, `${prefix}-Lambda`, {
  env,
  stage,
  uploadBucket: s3Stack.uploadBucket,
  imageMetadataTable: dynamoStack.imageMetadataTable,
  opsRecommendationsTable: dynamoStack.opsRecommendationsTable,
  agentRunsTable: dynamoStack.agentRunsTable,
  dlq: sqsStack.dlq,
  processingQueue: sqsStack.processingQueue,
  alertTopic: sqsStack.alertTopic,
});

const apiStack = new ApiStack(app, `${prefix}-API`, {
  env,
  stage,
  uploadUrlHandler: lambdaStack.uploadUrlHandler,
  metadataQueryHandler: lambdaStack.metadataQueryHandler,
  agenticOps: lambdaStack.agenticOps,
  userPool: cognitoStack.userPool,
});

new EventBridgeStack(app, `${prefix}-EventBridge`, {
  env,
  stage,
  imageMetadataTable: dynamoStack.imageMetadataTable,
  analyticsAggregator: lambdaStack.analyticsAggregator,
  failureMonitor: lambdaStack.failureMonitor,
  dlq: sqsStack.dlq,
});

new MonitoringStack(app, `${prefix}-Monitoring`, {
  env,
  stage,
  processorFunction: lambdaStack.rekognitionProcessor,
  uploadHandlerFunction: lambdaStack.uploadUrlHandler,
  opsAgentFunction: lambdaStack.opsAgent,
  dlq: sqsStack.dlq,
  alertTopic: sqsStack.alertTopic,
  imageMetadataTable: dynamoStack.imageMetadataTable,
});

cdk.Tags.of(app).add('Project', 'CloudVisionOps');
cdk.Tags.of(app).add('Environment', stage);
cdk.Tags.of(app).add('ManagedBy', 'CDK');
