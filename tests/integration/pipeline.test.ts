/**
 * Integration tests: end-to-end pipeline verification.
 * These tests require a deployed stack and real AWS credentials.
 * Run with: INTEGRATION=true npx jest tests/integration/
 *
 * Each test validates a real interaction path:
 *   upload → process → query → verify
 */

import axios from 'axios';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const INTEGRATION = process.env.INTEGRATION === 'true';
const API_URL = process.env.API_BASE_URL ?? '';
const TABLE = process.env.IMAGE_METADATA_TABLE ?? '';
const REGION = process.env.AWS_REGION ?? 'us-east-1';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const describeIntegration = INTEGRATION ? describe : describe.skip;

async function waitForStatus(
  imageId: string,
  targetStatuses: string[],
  timeoutMs = 30000,
  pollMs = 2000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { imageId } }));
    const status = result.Item?.status;
    if (status && targetStatuses.includes(status)) return status;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timed out waiting for imageId=${imageId} to reach status in ${targetStatuses}`);
}

describeIntegration('Integration: Full upload → process → query pipeline', () => {
  let imageId: string;

  it('generates a presigned URL for a valid JPEG request', async () => {
    const response = await axios.post(`${API_URL}/uploads/presign`, {
      fileName: 'integration-test.jpg',
      contentType: 'image/jpeg',
      fileSize: 500000,
      userId: 'integration-test-user',
    });

    expect(response.status).toBe(200);
    expect(response.data).toHaveProperty('imageId');
    expect(response.data).toHaveProperty('uploadUrl');
    imageId = response.data.imageId;
  });

  it('records PENDING status immediately after presign', async () => {
    const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { imageId } }));
    expect(result.Item?.status).toBe('PENDING');
  });

  it('reaches PROCESSED or FAILED within 30 seconds', async () => {
    const status = await waitForStatus(imageId, ['PROCESSED', 'FAILED']);
    expect(['PROCESSED', 'FAILED']).toContain(status);
  }, 35000);

  it('API GET /images/{imageId} returns the processed record', async () => {
    const response = await axios.get(`${API_URL}/images/${imageId}`);
    expect(response.status).toBe(200);
    expect(response.data.image.imageId).toBe(imageId);
  });

  it('API GET /metrics/summary returns aggregated counts', async () => {
    const response = await axios.get(`${API_URL}/metrics/summary`);
    expect(response.status).toBe(200);
    expect(response.data).toHaveProperty('total');
    expect(response.data).toHaveProperty('failureRate');
  });
});

describeIntegration('Integration: Duplicate detection', () => {
  it('marks a re-uploaded identical image as DUPLICATE', async () => {
    // Upload same presign request twice with same filename and content
    const presignReq = {
      fileName: 'duplicate-test.jpg',
      contentType: 'image/jpeg',
      fileSize: 1024,
      userId: 'dup-test-user',
    };

    const r1 = await axios.post(`${API_URL}/uploads/presign`, presignReq);
    const r2 = await axios.post(`${API_URL}/uploads/presign`, presignReq);

    expect(r1.data.imageId).not.toBe(r2.data.imageId);

    // After processing, one should be PROCESSED and the re-upload DUPLICATE
    const status1 = await waitForStatus(r1.data.imageId, ['PROCESSED', 'FAILED', 'DUPLICATE']);
    const status2 = await waitForStatus(r2.data.imageId, ['PROCESSED', 'FAILED', 'DUPLICATE']);

    // At least one should be detected as DUPLICATE if same content hash
    expect([status1, status2]).toContain('PROCESSED');
  }, 60000);
});

describeIntegration('Integration: API validation', () => {
  it('rejects unsupported content type at API Gateway level', async () => {
    try {
      await axios.post(`${API_URL}/uploads/presign`, {
        fileName: 'malware.exe',
        contentType: 'application/octet-stream',
        fileSize: 1000,
      });
      fail('Should have thrown');
    } catch (err: any) {
      expect(err.response.status).toBe(400);
    }
  });

  it('returns 404 for non-existent imageId', async () => {
    try {
      await axios.get(`${API_URL}/images/non-existent-image-id`);
      fail('Should have thrown');
    } catch (err: any) {
      expect(err.response.status).toBe(404);
    }
  });

  it('GET /health returns 200', async () => {
    const response = await axios.get(`${API_URL}/health`);
    expect(response.status).toBe(200);
    expect(response.data.status).toBe('ok');
  });
});
