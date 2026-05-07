# Failure Recovery Design

## Error Taxonomy

| Error Type | Cause | Recoverable? | Strategy |
|-----------|-------|-------------|---------|
| S3_READ_ERROR | Object missing, permission denied | Maybe | Check IAM role, re-trigger after fix |
| REKOGNITION_ERROR | Invalid image, API limit, service outage | Yes (transient) | Retry with backoff |
| DYNAMODB_WRITE_ERROR | Throttling, capacity exceeded | Yes | Retry with backoff, check capacity mode |
| TIMEOUT_ERROR | Lambda timeout, slow Rekognition | Yes | Retry with backoff, increase timeout |
| VALIDATION_ERROR | Invalid file format, oversized file | No | Reject immediately, notify user |
| DUPLICATE_DETECTED | Same image hash exists | N/A | Skip Rekognition, mark DUPLICATE |
| UNKNOWN_ERROR | Unclassified failure | Maybe | Send to DLQ for manual inspection |

---

## Retry Architecture

### Layer 1: In-Lambda Retry (transient AWS errors)
- `withRetry(fn, maxAttempts=3, baseDelayMs=200)`
- Full jitter: `sleep(random * min(30000, base * 2^attempt))`
- Covers: Rekognition 500s, DynamoDB transient throttles

### Layer 2: DynamoDB Conditional Write (duplicate execution)
- `acquireIdempotencyLock(key)` uses `ConditionExpression: attribute_not_exists`
- If lock exists: skip (already processed or in-progress)
- Prevents re-processing on S3 duplicate event delivery

### Layer 3: SQS FIFO + Dead Letter Queue
- `maxReceiveCount: 3` — three attempts before moving to DLQ
- DLQ retention: 14 days
- DLQ visibility timeout: 300s (matches processor)

### Layer 4: DLQ Replay Lambda
- Reads up to 10 messages from DLQ per invocation
- Re-runs full Rekognition pipeline
- Delay between replays: 1s (prevents Rekognition burst)
- Sets `replaySource: DLQ_REPLAY` for traceability
- Deletes from DLQ only after confirmed success

---

## Failure State Machine

```
PENDING
  └─► PROCESSING
        ├─► PROCESSED          (success)
        ├─► DUPLICATE          (hash match found)
        └─► FAILED             (all retries exhausted)
              └─► DLQ          (sent for replay)
                    ├─► PROCESSED  (replay succeeded)
                    └─► FAILED     (replay failed, stays in DLQ)
```

---

## DLQ Replay Procedure

1. Verify root cause is resolved (e.g., Rekognition was down → now up)
2. Call `POST /replay` API or invoke DLQ Replay Lambda directly
3. Lambda reads up to 10 DLQ messages per batch
4. Each message is re-processed through the full pipeline
5. Successful jobs are deleted from DLQ; failed jobs remain for next replay
6. Each replay increments `retryCount` and sets `replayedAt`

---

## EventBridge Pipes Failure Handling

Each pipe has its own DLQ (`deadLetterConfig.arn`) for unprocessable stream events.
`maximumRetryAttempts` per pipe:
- Processed pipe: 3 retries
- Failed pipe: 2 retries
- Low confidence pipe: 2 retries
- High retry pipe: 1 retry (aggressive escalation)

---

## Circuit Breaker Pattern (Ops Agent)

The ops agent detects failure rate > 5% and publishes a HIGH severity alert.
On SNS receipt, the operations team can:
1. Pause the S3 event notification rule (stops new processing jobs)
2. Fix root cause
3. Re-enable and trigger DLQ replay

This prevents a cascading storm of retries during a Rekognition outage.

---

## Idempotency Design

Every S3 event that triggers the processor is keyed by `bucket::key::etag`.
S3 can deliver the same event more than once on:
- Lambda timeout (S3 retries)
- S3 bucket notification retry
- EventBridge delivery retry

The DynamoDB idempotency table prevents double-processing with a 24h TTL window.
Conditional write pattern (PutItem + ConditionExpression) is atomic and consistent.

---

## Chaos Test Scenarios

| Test | Expected Behavior |
|------|-------------------|
| Invalid JPEG (corrupt bytes) | REKOGNITION_ERROR, status=FAILED, sent to DLQ |
| File not in S3 (S3_READ_ERROR) | S3_READ_ERROR, status=FAILED, sent to DLQ |
| Rekognition mock 503 | Retry x3 with jitter, then FAILED |
| DynamoDB mock throttle | DYNAMODB_WRITE_ERROR, retry x3, then FAILED |
| Lambda timeout (60s exceeded) | TIMEOUT_ERROR by next invocation, DLQ |
| Duplicate S3 event | Idempotency lock acquired by first, second skips |
| DLQ replay success | status=PROCESSED, replaySource=DLQ_REPLAY |
| DLQ replay failure | retryCount++, remains in DLQ |
| 50% batch failure | Individual items fail independently, others succeed |
