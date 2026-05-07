/**
 * Unit tests for the upload URL handler.
 * AWS SDK calls are mocked — this tests validation logic only.
 */

jest.mock('@aws-sdk/client-s3');
jest.mock('@aws-sdk/s3-request-presigner');
jest.mock('../../backend/shared/utils', () => ({
  ...jest.requireActual('../../backend/shared/utils'),
  writeMetadata: jest.fn().mockResolvedValue(undefined),
  getEnvVar: (name: string) => {
    const env: Record<string, string> = {
      UPLOAD_BUCKET: 'test-bucket',
      IMAGE_METADATA_TABLE: 'test-table',
    };
    return env[name] ?? '';
  },
}));

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<typeof getSignedUrl>;
mockGetSignedUrl.mockResolvedValue('https://s3.amazonaws.com/test-signed-url');

import { handler } from '../../backend/lambdas/upload-url-handler/index';
import { APIGatewayProxyEvent } from 'aws-lambda';

function makeEvent(body: unknown): APIGatewayProxyEvent {
  return {
    body: JSON.stringify(body),
    requestContext: { requestId: 'test-request-id' },
  } as any;
}

describe('UploadUrlHandler', () => {
  it('returns 400 when body is missing', async () => {
    const result = await handler({ body: null } as any);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/body/i);
  });

  it('returns 400 for unsupported content type', async () => {
    const result = await handler(makeEvent({
      fileName: 'test.gif',
      contentType: 'image/gif',
      fileSize: 1000,
    }));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/jpeg|png/i);
  });

  it('returns 400 when file exceeds max size', async () => {
    const result = await handler(makeEvent({
      fileName: 'huge.jpg',
      contentType: 'image/jpeg',
      fileSize: 20 * 1024 * 1024, // 20 MB
    }));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/max/i);
  });

  it('returns 400 for invalid file name characters', async () => {
    const result = await handler(makeEvent({
      fileName: '../etc/passwd',
      contentType: 'image/jpeg',
      fileSize: 1000,
    }));
    expect(result.statusCode).toBe(400);
  });

  it('returns 200 with imageId and uploadUrl for valid request', async () => {
    const result = await handler(makeEvent({
      fileName: 'photo.jpg',
      contentType: 'image/jpeg',
      fileSize: 500000,
      userId: 'user-123',
    }));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body).toHaveProperty('imageId');
    expect(body).toHaveProperty('uploadUrl');
    expect(body.uploadUrl).toBe('https://s3.amazonaws.com/test-signed-url');
  });

  it('accepts PNG content type', async () => {
    const result = await handler(makeEvent({
      fileName: 'image.png',
      contentType: 'image/png',
      fileSize: 100000,
    }));
    expect(result.statusCode).toBe(200);
  });

  it('returns 400 when required fields are missing', async () => {
    const result = await handler(makeEvent({ fileName: 'test.jpg' }));
    expect(result.statusCode).toBe(400);
  });
});
