import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

interface DynamoDBStackProps extends cdk.StackProps {
  stage: string;
}

export class DynamoDBStack extends cdk.Stack {
  public readonly imageMetadataTable: dynamodb.Table;
  public readonly opsRecommendationsTable: dynamodb.Table;
  public readonly idempotencyTable: dynamodb.Table;
  public readonly agentRunsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DynamoDBStackProps) {
    super(scope, id, props);

    const { stage } = props;

    // Primary image metadata table with DynamoDB Streams for event-driven downstream
    this.imageMetadataTable = new dynamodb.Table(this, 'ImageMetadataTable', {
      tableName: `CloudVisionOps-ImageMetadata-${stage}`,
      partitionKey: { name: 'imageId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'ttl',
    });

    // GSI 1: query by userId + time range (user history)
    this.imageMetadataTable.addGlobalSecondaryIndex({
      indexName: 'userId-createdAt-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI 2: query by processing status (ops monitoring, failure recovery)
    this.imageMetadataTable.addGlobalSecondaryIndex({
      indexName: 'status-updatedAt-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI 3: query by dominant label + confidence (content-based analytics)
    this.imageMetadataTable.addGlobalSecondaryIndex({
      indexName: 'dominantLabel-confidenceScore-index',
      partitionKey: { name: 'dominantLabel', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'confidenceScore', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['imageId', 'userId', 'status', 'processingLatencyMs', 'createdAt'],
    });

    // GSI 4: query by imageHash for duplicate detection (avoids full scan)
    this.imageMetadataTable.addGlobalSecondaryIndex({
      indexName: 'imageHash-index',
      partitionKey: { name: 'imageHash', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['imageId', 'status', 'createdAt', 'userId'],
    });

    // Ops recommendations produced by the autonomous agent
    this.opsRecommendationsTable = new dynamodb.Table(this, 'OpsRecommendationsTable', {
      tableName: `CloudVisionOps-OpsRecommendations-${stage}`,
      partitionKey: { name: 'recommendationId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    this.opsRecommendationsTable.addGlobalSecondaryIndex({
      indexName: 'severity-timestamp-index',
      partitionKey: { name: 'severity', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.opsRecommendationsTable.addGlobalSecondaryIndex({
      indexName: 'category-status-index',
      partitionKey: { name: 'category', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Agentic ops run history: each Claude-driven diagnostic run with full reasoning trace
    this.agentRunsTable = new dynamodb.Table(this, 'AgentRunsTable', {
      tableName: `CloudVisionOps-AgentRuns-${stage}`,
      partitionKey: { name: 'runId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // GSI: list runs sorted by time (for frontend "latest run" query)
    this.agentRunsTable.addGlobalSecondaryIndex({
      indexName: 'status-timestamp-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Idempotency table: prevents duplicate Lambda executions on S3 retries
    // Uses TTL to auto-expire old entries (24h window)
    this.idempotencyTable = new dynamodb.Table(this, 'IdempotencyTable', {
      tableName: `CloudVisionOps-Idempotency-${stage}`,
      partitionKey: { name: 'idempotencyKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiry',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    new cdk.CfnOutput(this, 'ImageMetadataTableName', {
      value: this.imageMetadataTable.tableName,
      exportName: `${id}-ImageMetadataTableName`,
    });

    new cdk.CfnOutput(this, 'ImageMetadataStreamArn', {
      value: this.imageMetadataTable.tableStreamArn!,
      exportName: `${id}-ImageMetadataStreamArn`,
    });

    new cdk.CfnOutput(this, 'OpsRecommendationsTableName', {
      value: this.opsRecommendationsTable.tableName,
      exportName: `${id}-OpsRecommendationsTableName`,
    });

    new cdk.CfnOutput(this, 'IdempotencyTableName', {
      value: this.idempotencyTable.tableName,
      exportName: `${id}-IdempotencyTableName`,
    });

    new cdk.CfnOutput(this, 'AgentRunsTableName', {
      value: this.agentRunsTable.tableName,
      exportName: `${id}-AgentRunsTableName`,
    });
  }
}
