import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  getEnvVar,
  createLogger,
  getDDBClient,
  apiResponse,
} from '../../shared/utils';

const logger = createLogger('MetadataQueryHandler');

const TABLE = () => getEnvVar('IMAGE_METADATA_TABLE');
const AGENT_RUNS_TABLE = () => process.env['AGENT_RUNS_TABLE'] ?? '';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const { httpMethod, path, pathParameters, queryStringParameters } = event;

  logger.info('Metadata query', { method: httpMethod, path });

  const ddb = getDDBClient();
  const table = TABLE();

  try {
    // GET /images/{imageId}
    if (pathParameters?.imageId) {
      const result = await ddb.send(new GetCommand({
        TableName: table,
        Key: { imageId: pathParameters.imageId },
      }));

      if (!result.Item) {
        return apiResponse(404, { error: 'Image not found' });
      }

      return apiResponse(200, { image: result.Item });
    }

    // GET /metrics/summary
    if (path.includes('/metrics/summary')) {
      return await getMetricsSummary(ddb, table);
    }

    // GET /agent/runs
    if (path.includes('/agent/runs')) {
      const agentTable = AGENT_RUNS_TABLE();
      const limit = Math.min(parseInt(queryStringParameters?.limit ?? '5', 10), 20);
      if (!agentTable) return apiResponse(200, { runs: [] });
      const result = await ddb.send(new QueryCommand({
        TableName: agentTable,
        IndexName: 'status-timestamp-index',
        KeyConditionExpression: '#s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': 'COMPLETED' },
        ScanIndexForward: false,
        Limit: limit,
      }));
      return apiResponse(200, { runs: result.Items ?? [] });
    }

    // GET /images?userId=...&limit=...&status=...
    const userId = queryStringParameters?.userId;
    const status = queryStringParameters?.status;
    const limit = Math.min(parseInt(queryStringParameters?.limit ?? '20', 10), 100);
    const lastEvaluatedKey = queryStringParameters?.nextToken
      ? JSON.parse(Buffer.from(queryStringParameters.nextToken, 'base64').toString())
      : undefined;

    if (userId) {
      const result = await ddb.send(new QueryCommand({
        TableName: table,
        IndexName: 'userId-createdAt-index',
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: lastEvaluatedKey,
      }));

      return apiResponse(200, {
        images: result.Items ?? [],
        count: result.Count ?? 0,
        nextToken: result.LastEvaluatedKey
          ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
          : null,
      });
    }

    if (status) {
      const result = await ddb.send(new QueryCommand({
        TableName: table,
        IndexName: 'status-updatedAt-index',
        KeyConditionExpression: '#s = :status',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':status': status },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: lastEvaluatedKey,
      }));

      return apiResponse(200, {
        images: result.Items ?? [],
        count: result.Count ?? 0,
        nextToken: result.LastEvaluatedKey
          ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
          : null,
      });
    }

    // Default: recent images via scan (bounded by limit)
    const result = await ddb.send(new ScanCommand({
      TableName: table,
      Limit: limit,
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    return apiResponse(200, {
      images: result.Items ?? [],
      count: result.Count ?? 0,
      nextToken: result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
        : null,
    });
  } catch (err) {
    logger.error('Metadata query failed', { error: err instanceof Error ? err.message : String(err) });
    return apiResponse(500, { error: 'Internal server error' });
  }
};

async function getMetricsSummary(ddb: DynamoDBDocumentClient, table: string): Promise<APIGatewayProxyResult> {
  const statusList = ['PROCESSED', 'FAILED', 'DUPLICATE', 'PENDING', 'PROCESSING'];

  const counts = await Promise.all(
    statusList.map(async (status) => {
      const result = await ddb.send(new QueryCommand({
        TableName: table,
        IndexName: 'status-updatedAt-index',
        KeyConditionExpression: '#s = :status',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':status': status },
        Select: 'COUNT',
      }));
      return { status, count: result.Count ?? 0 };
    })
  );

  const summary = Object.fromEntries(counts.map(({ status, count }) => [status, count]));
  const total = Object.values(summary).reduce((a, b) => a + b, 0);
  const failureRate = total > 0 ? (summary['FAILED'] ?? 0) / total : 0;
  const duplicateRate = total > 0 ? (summary['DUPLICATE'] ?? 0) / total : 0;

  return apiResponse(200, {
    summary,
    total,
    failureRate: parseFloat(failureRate.toFixed(4)),
    duplicateRate: parseFloat(duplicateRate.toFixed(4)),
    timestamp: new Date().toISOString(),
  });
}
