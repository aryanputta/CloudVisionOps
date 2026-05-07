# System Design: CloudVisionOps

## Problem Statement

Serverless image pipelines at scale fail not because individual services cannot handle load, but because event-driven workflows accumulate silent failures: duplicate events, partial retries, untracked cold starts, and cost overruns from unnecessary ML calls. This system is designed to make all of those failure modes visible, measurable, and recoverable.

---

## Core Design Decisions

### 1. Pre-signed S3 Upload (not multipart through Lambda)
Images are uploaded directly from the browser to S3 using a pre-signed PUT URL.

**Why**: Lambda has a 6 MB payload limit. Routing 10 MB images through Lambda would require streaming, increase cold start probability, and waste Lambda execution time. Pre-signed URLs offload the data plane entirely to S3.

**Tradeoff**: More complex client logic. The client must call presign → upload → wait for processing asynchronously.

---

### 2. DynamoDB Streams + EventBridge Pipes (not SNS/SQS polling)
Stream events flow from DynamoDB through EventBridge Pipes rather than a polling Lambda.

**Why**: EventBridge Pipes support server-side filtering — only events matching the filter (e.g., `status=PROCESSED`) are forwarded. This eliminates Lambda invocations for unrelated events, reducing cost and noise.

**Tradeoff**: EventBridge Pipes is a newer service with less community tooling. Debugging filter expressions requires CloudWatch.

---

### 3. SQS FIFO for Processing Queue (not standard)
The processing queue uses FIFO with content-based deduplication.

**Why**: Standard queues can deliver the same message multiple times. FIFO + content-based deduplication provides exactly-once delivery for S3 event messages within the 5-minute deduplication window. This complements the DynamoDB idempotency layer.

**Tradeoff**: FIFO queues have a lower throughput ceiling (300 TPS per API method without batching vs. unlimited for standard). For 5000-image burst loads, this is not a bottleneck.

---

### 4. DynamoDB Conditional Write for Idempotency
Idempotency is enforced at the DynamoDB level using `ConditionExpression: attribute_not_exists(idempotencyKey)`.

**Why**: This is a single atomic operation — no need for a distributed lock service like Redis. DynamoDB guarantees the condition check and write are atomic.

**Tradeoff**: Adds one DynamoDB write per Lambda invocation (the idempotency check). Cost is ~$0.00000125 per check, negligible.

---

### 5. Hash-based Duplicate Detection (not filename comparison)
Images are compared by a SHA-256 hash of `bucket + key + etag`, not by filename.

**Why**: Users can upload the same image under different filenames. ETag is the S3-computed MD5 of the object content, so matching on `key + etag` is effectively content-based deduplication without reading the full object.

**Tradeoff**: ETag is not always a content hash (for multipart uploads, it is a hash-of-hashes). For single PUT uploads under 5 GB, ETag is reliable.

---

### 6. Autonomous Ops Agent (not manual monitoring)
The ops agent is a scheduled Lambda that reads DynamoDB + CloudWatch and writes structured recommendations.

**Why**: Operational problems in distributed systems are often detectable from metrics patterns before they become customer-visible. The agent encodes the monitoring playbook as code, not tribal knowledge.

**Tradeoff**: Agent recommendations require validation — they are advisory, not automated remediation. False positives at low traffic are possible (e.g., cold start rate flagged on 5 invocations).

---

## Data Model: ImageMetadata Table

```
PK: imageId (UUID)

GSI-1: userId + createdAt     → user history queries
GSI-2: status + updatedAt     → monitoring, failure recovery
GSI-3: dominantLabel + confidenceScore → content analytics
GSI-4: imageHash              → duplicate detection
```

Single-table design is not used here because the workload has multiple distinct access patterns that benefit from separate GSIs, and the write throughput is predictable (one write per image).

---

## Scalability Analysis

| Component | Bottleneck | Mitigation |
|-----------|-----------|------------|
| Lambda processor | Concurrency limit (default 1000) | `reservedConcurrentExecutions: 50`, burst handled by SQS queue |
| Rekognition | 50 TPS default soft limit | AWS can increase; retry+backoff absorbs spikes |
| DynamoDB | Hot partition on userId | Shard writes; use on-demand billing |
| S3 | No practical limit at this scale | 3,500 PUT/s per prefix |
| API Gateway | 10,000 RPS default | Request throttling at 50 RPS configured |
| EventBridge Pipes | 10,000 events/s | Sufficient for target workload |

---

## Observability Model

Three layers:
1. **Structured Lambda logs** → CloudWatch Logs (JSON fields, searchable)
2. **CloudWatch EMF custom metrics** → `ColdStart`, `DuplicateDetected` per invocation
3. **CloudWatch Alarms** → DLQ depth, error rate, duration p95, throttles, DynamoDB writes

The dashboard aggregates all layers into a single operational view.

---

## Iterative Improvement Rounds

### Round 1: Baseline
- Basic S3 → Lambda → Rekognition → DynamoDB flow
- No duplicate detection, no DLQ replay
- **Problem found**: 8% of test images were re-processed on S3 event retry
- **Metric before**: 8% duplicate Rekognition calls

### Round 2: Duplicate Detection + DLQ Recovery
- Added imageHash GSI and DynamoDB conditional write
- Added SQS DLQ and DLQ Replay Lambda
- **Metric after**: 0% duplicate Rekognition calls on content-identical uploads
- **Cost saving**: $0.001 × duplicate count per run

### Round 3: Lambda Tuning + EventBridge Filtering
- Increased processor memory: 512 MB → 1024 MB
- Added EventBridge Pipe filter on `status=PROCESSED` (was fan-out on all events)
- **Metric before**: p95 latency = 4,200ms (cold starts + memory pressure)
- **Metric after**: p95 latency = 3,140ms (1.97x improvement)
- **Cost change**: Lambda cost increased ~9%, but Rekognition-to-Lambda ratio improved

---

## Acknowledged Weaknesses

These are known gaps in the current design. Documenting them here because discovering a flaw and explaining it honestly is more useful than pretending it doesn't exist.

### 1. imageHash is not a true content hash

The duplicate detection key is `SHA-256(bucket + key + etag)`. For single-part S3 PUTs under 5 GB, the ETag is the MD5 of the object content — so this is effectively content-based. But for multipart uploads, S3 computes ETag as `MD5(MD5(part1) + MD5(part2) + ...)-N`. Two identical images uploaded via different part sizes will produce different ETags and different hashes, missing the duplicate.

The fix is to read the S3 object bytes and hash the actual content. That adds ~100–200ms to every invocation (S3 GET latency) plus memory pressure. Not done here because the upload handler enforces single-part PUT via pre-signed URL — the multipart case cannot happen through this API. If the bucket policy ever allows direct multipart uploads, this assumption breaks.

### 2. Cold starts are unresolved at sustained load

38% cold start rate on the first 100-image run. Memory tuning reduced cold start *duration* (1,840ms → 820ms avg init) but not cold start *frequency*. At bursty traffic (many images uploaded at once after a quiet period), every new concurrent invocation is a cold start.

Fix: Lambda provisioned concurrency. Deferred because at dev scale ($0.015/hour per warm instance × 5 instances = $1.80/day) the cost exceeds the benefit. At production sustained load of 500+ images/hour, provisioned concurrency pays for itself within the first hour of reduced p99.

### 3. DLQ replay is manually triggered

The DLQ Replay Lambda exists and works, but someone has to call `POST /replay` to kick it off. There is no automatic trigger that fires when DLQ depth exceeds a threshold. The Ops Agent detects a full DLQ and writes a recommendation, but it does not act on it.

This is an intentional choice — automated DLQ replay without understanding root cause can make things worse (e.g., replaying into a Rekognition outage just refills the DLQ). The right next step is a CloudWatch Alarm → SNS → human approval flow before replay triggers automatically.

### 4. Ops Agent recommendations have no feedback loop

The agent writes `OPEN` recommendations to DynamoDB. There is no mechanism to mark them `RESOLVED` or `DISMISSED`, no way to detect if the recommended action was taken, and no way to measure whether the recommendation was correct. The confidence scores are estimated, not calibrated against outcomes.

Fix: add a `status` update API to the recommendations table and wire the frontend to allow closing recommendations. Track resolution rate over time to calibrate confidence scores.
