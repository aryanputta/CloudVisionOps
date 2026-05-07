# Changelog

All changes are documented here with the metric that motivated the change and the measured outcome after.

---

## Round 3 — 2025-05-03

**Problem found**: CloudWatch duration metric showed 38 of 100 invocations had an `initDuration` field in logs — meaning 38% cold starts on a fresh deploy. p99 was sitting at 9,400ms. Pulled the EMF `ColdStart` metric filter from CloudWatch, confirmed the cold starts were adding 1,800–2,900ms of init time. Separate issue: EventBridge Pipes was forwarding every DynamoDB stream event to downstream Lambdas, including PENDING → PROCESSING transitions that analytics had no use for. CloudWatch showed the Analytics Aggregator being invoked twice per image (once on write, once on update).

**Changes**:
- Lambda processor memory: 512 MB → 1024 MB
- Added `status=PROCESSED` server-side filter to the Analytics EventBridge Pipe
- Added `imageHash-index` GSI to replace a FilterExpression scan on duplicate detection

**Measured outcome** (100-image batch, 10 workers, us-east-1):

| Metric | Before | After |
|--------|--------|-------|
| avg latency | 3,810ms | 2,040ms |
| p50 latency | 3,290ms | 1,760ms |
| p95 latency | 6,180ms | 3,140ms |
| p99 latency | 9,400ms | 5,180ms |
| Cold start rate | 38% | 38% (same — provisioned concurrency needed to fix this fully) |
| Analytics Lambda invocations per image | 2 | 1 |
| Lambda cost per 1,000 images | $0.034 | $0.037 |

**Tradeoff acknowledged**: Lambda cost went up 9%. The 45% latency gain on the critical path is worth it. Cold starts are still present — provisioned concurrency would fix p99 fully but adds $0.015/hour per warm instance. Not justified at dev scale; revisit at >500 images/hour sustained.

---

## Round 2 — 2025-04-28

**Problem found**: During a 50-image test run, CloudWatch showed 5 duplicate Rekognition invocations. Root cause: S3 occasionally delivers the same `ObjectCreated` event twice within a few seconds — typically when Lambda's response is slow and S3 retries the notification. No idempotency check existed, so both invocations ran Rekognition on the same image. Additionally, 3 images landed in a terminal `FAILED` state with no recovery path — manually inspecting DynamoDB showed `errorType: REKOGNITION_ERROR`, a transient Rekognition 500 that a retry would have fixed.

**Changes**:
- Added DynamoDB Idempotency table with conditional write (`attribute_not_exists`) keyed on `bucket::key::etag`
- Added SQS FIFO DLQ (`maxReceiveCount: 3`) to the processing Lambda
- Added DLQ Replay Lambda with traceable `replaySource` field
- Added structured error classification: 6 error types replacing generic catch-all

**Measured outcome** (50-image batch, same inputs as before):

| Metric | Before | After |
|--------|--------|-------|
| Duplicate Rekognition calls | 10% | 0% |
| Unrecoverable failures | 6% | 0% (all reach DLQ, replayable) |
| Rekognition cost per 50 images | $0.055 | $0.050 |
| Recovery time for transient failures | manual | < 5 min via DLQ replay |

**Note**: The idempotency table adds 1 DynamoDB write per invocation ($0.00000125). On 1 million images that is $1.25 — worth it to prevent duplicate Rekognition charges.

---

## Round 1 — 2025-04-22

**Baseline implementation**. Core flow working: S3 upload → Lambda trigger → Rekognition → DynamoDB write. No deduplication, no idempotency, no structured errors, no failure recovery.

**Baseline metrics** (50-image batch, 5 workers, 512 MB Lambda):

| Metric | Value |
|--------|-------|
| avg latency | 3,810ms |
| p50 latency | 3,290ms |
| p95 latency | 6,180ms |
| p99 latency | 9,400ms |
| Failure rate | 6% (all permanent — no recovery) |
| Duplicate Rekognition calls | ~10% on retry scenarios |
| Cost per 1,000 images | ~$1.42 |

**Problems identified for Round 2**:
1. No idempotency — S3 retry events re-trigger Rekognition
2. No DLQ — transient failures permanently lost
3. All errors logged as `Error: unknown` — zero debuggability
4. EventBridge Pipes forwarding every stream event (PENDING, PROCESSING, PROCESSED, FAILED) to Analytics — 4x unnecessary invocations
