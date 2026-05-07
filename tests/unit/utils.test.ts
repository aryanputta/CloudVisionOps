import {
  parseS3Event,
  parseRekognitionLabels,
  getDominantLabel,
  calculateLatency,
  classifyError,
  calculateS3KeyHash,
  withRetry,
} from '../../backend/shared/utils';

describe('parseS3Event', () => {
  it('parses a standard S3 ObjectCreated event', () => {
    const event = {
      Records: [
        {
          eventTime: '2024-01-01T00:00:00.000Z',
          awsRegion: 'us-east-1',
          s3: {
            bucket: { name: 'test-bucket' },
            object: { key: 'uploads%2Fuser%2Fabc.jpg', size: 102400, eTag: '"abc123"' },
          },
        },
      ],
    };

    const records = parseS3Event(event);
    expect(records).toHaveLength(1);
    expect(records[0].bucket).toBe('test-bucket');
    expect(records[0].key).toBe('uploads/user/abc.jpg');
    expect(records[0].size).toBe(102400);
    expect(records[0].etag).toBe('abc123');
  });

  it('decodes URL-encoded keys with plus signs', () => {
    const event = {
      Records: [
        {
          eventTime: '2024-01-01T00:00:00.000Z',
          awsRegion: 'us-east-1',
          s3: {
            bucket: { name: 'bucket' },
            object: { key: 'my+image+file.jpg', size: 1, eTag: '"x"' },
          },
        },
      ],
    };
    const records = parseS3Event(event);
    expect(records[0].key).toBe('my image file.jpg');
  });

  it('throws on missing Records', () => {
    expect(() => parseS3Event({})).toThrow('Invalid S3 event: missing Records');
  });

  it('throws on missing s3 field', () => {
    expect(() => parseS3Event({ Records: [{ eventTime: '', awsRegion: '' }] })).toThrow(
      'Invalid S3 event record: missing s3 field'
    );
  });
});

describe('parseRekognitionLabels', () => {
  it('parses label list correctly', () => {
    const raw = [
      {
        Name: 'Person',
        Confidence: 99.5,
        Categories: [{ Name: 'People' }],
        Parents: [],
        Instances: [{ BoundingBox: {} }],
      },
      {
        Name: 'Outdoor',
        Confidence: 85.0,
        Categories: [],
        Parents: [{ Name: 'Nature' }],
        Instances: [],
      },
    ];

    const labels = parseRekognitionLabels(raw);
    expect(labels).toHaveLength(2);
    expect(labels[0].name).toBe('Person');
    expect(labels[0].confidence).toBe(99.5);
    expect(labels[0].hasBoundingBox).toBe(true);
    expect(labels[1].hasBoundingBox).toBe(false);
    expect(labels[1].parents).toContain('Nature');
  });

  it('handles empty label list', () => {
    expect(parseRekognitionLabels([])).toHaveLength(0);
  });
});

describe('getDominantLabel', () => {
  it('returns label with highest confidence', () => {
    const labels = [
      { name: 'Dog', confidence: 80, categories: [], parents: [], hasBoundingBox: false },
      { name: 'Animal', confidence: 99, categories: [], parents: [], hasBoundingBox: false },
      { name: 'Pet', confidence: 75, categories: [], parents: [], hasBoundingBox: false },
    ];
    expect(getDominantLabel(labels)).toBe('Animal');
  });

  it('returns UNKNOWN for empty array', () => {
    expect(getDominantLabel([])).toBe('UNKNOWN');
  });
});

describe('calculateLatency', () => {
  it('returns a non-negative number', () => {
    const start = Date.now() - 100;
    expect(calculateLatency(start)).toBeGreaterThanOrEqual(100);
  });
});

describe('classifyError', () => {
  it('classifies S3 errors', () => {
    const err = new Error('NoSuchKey');
    err.name = 'NoSuchKey';
    expect(classifyError(err)).toBe('S3_READ_ERROR');
  });

  it('classifies DynamoDB throughput errors', () => {
    const err = new Error('throttled');
    err.name = 'ProvisionedThroughputExceededException';
    expect(classifyError(err)).toBe('DYNAMODB_WRITE_ERROR');
  });

  it('classifies unknown errors', () => {
    expect(classifyError(new Error('some random failure'))).toBe('UNKNOWN_ERROR');
  });

  it('handles non-Error values', () => {
    expect(classifyError('string error')).toBe('UNKNOWN_ERROR');
  });
});

describe('calculateS3KeyHash', () => {
  it('produces different hashes for different keys', () => {
    const h1 = calculateS3KeyHash('bucket', 'key1', 'etag1');
    const h2 = calculateS3KeyHash('bucket', 'key2', 'etag1');
    expect(h1).not.toBe(h2);
  });

  it('produces same hash for identical inputs', () => {
    const h1 = calculateS3KeyHash('bucket', 'key', 'etag');
    const h2 = calculateS3KeyHash('bucket', 'key', 'etag');
    expect(h1).toBe(h2);
  });
});

describe('withRetry', () => {
  it('resolves on first attempt if no error', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const result = await withRetry(fn, 3, 0);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and eventually resolves', async () => {
    let calls = 0;
    const fn = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    });
    const result = await withRetry(fn, 3, 0);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting all attempts', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('permanent failure'));
    await expect(withRetry(fn, 2, 0)).rejects.toThrow('permanent failure');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
