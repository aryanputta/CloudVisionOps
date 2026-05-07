import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import {
  getEnvVar,
  createLogger,
  writeMetadata,
  apiResponse,
} from '../../shared/utils';

const logger = createLogger('UploadUrlHandler');

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });

const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png']);
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_BYTES ?? '10485760', 10);
const PRESIGN_EXPIRY = parseInt(process.env.PRESIGNED_URL_EXPIRY_SECONDS ?? '300', 10);

interface PresignRequest {
  fileName: string;
  contentType: string;
  fileSize: number;
  userId?: string;
}

let coldStart = true;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const isCold = coldStart;
  coldStart = false;

  const requestId = event.requestContext?.requestId ?? randomUUID();
  logger.info('Upload URL request', { requestId, coldStart: isCold });

  if (!event.body) {
    return apiResponse(400, { error: 'Request body is required' });
  }

  let body: PresignRequest;
  try {
    body = JSON.parse(event.body);
  } catch {
    return apiResponse(400, { error: 'Invalid JSON body' });
  }

  const { fileName, contentType, fileSize, userId } = body;

  if (!fileName || !contentType || !fileSize) {
    return apiResponse(400, { error: 'fileName, contentType, and fileSize are required' });
  }

  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return apiResponse(400, { error: 'Only image/jpeg and image/png are allowed' });
  }

  if (fileSize > MAX_FILE_SIZE) {
    return apiResponse(400, { error: `File size exceeds maximum of ${MAX_FILE_SIZE} bytes` });
  }

  if (!/^[a-zA-Z0-9._\-\s]+$/.test(fileName)) {
    return apiResponse(400, { error: 'fileName contains invalid characters' });
  }

  const bucket = getEnvVar('UPLOAD_BUCKET');
  const metadataTable = getEnvVar('IMAGE_METADATA_TABLE');

  const imageId = randomUUID();
  const extension = contentType === 'image/png' ? 'png' : 'jpg';
  const objectKey = `uploads/${userId ?? 'anonymous'}/${imageId}.${extension}`;
  const now = new Date().toISOString();

  try {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      ContentType: contentType,
      ContentLength: fileSize,
      Metadata: {
        'x-image-id': imageId,
        'x-user-id': userId ?? 'anonymous',
        'x-original-filename': encodeURIComponent(fileName),
      },
    });

    const presignedUrl = await getSignedUrl(s3, command, { expiresIn: PRESIGN_EXPIRY });

    // Pre-register the image as PENDING in DynamoDB before upload completes
    // This ensures the processor can always find metadata even on retries
    await writeMetadata(metadataTable, {
      imageId,
      userId: userId ?? 'anonymous',
      bucketName: bucket,
      objectKey,
      originalFileName: fileName,
      contentType,
      fileSize,
      status: 'PENDING',
      retryCount: 0,
      uploadTime: now,
      createdAt: now,
      updatedAt: now,
    });

    logger.info('Presigned URL generated', { imageId, objectKey, userId, coldStart: isCold });

    return apiResponse(200, {
      imageId,
      uploadUrl: presignedUrl,
      objectKey,
      expiresIn: PRESIGN_EXPIRY,
      instructions: `PUT ${contentType} body to uploadUrl with Content-Type header set`,
    });
  } catch (err) {
    logger.error('Failed to generate presigned URL', {
      error: err instanceof Error ? err.message : String(err),
      imageId,
    });
    return apiResponse(500, { error: 'Failed to generate upload URL' });
  }
};
