# Investigation Log

How each problem was found and what the data showed before the fix.

---

## INV-003 — 2025-05-03: Cold starts dominating p99 latency

**Trigger**: After Round 2 deploy, ran a 100-image benchmark and noticed p99 was 9,400ms despite avg being 3,810ms. Spread of 5,590ms between avg and p99 was too large to be normal variance.

**Investigation**:
1. Pulled CloudWatch Logs Insights query on the processor log group:
   ```
   fields @initDuration, @duration, @memorySize
   | filter @initDuration > 0
   | stats count() as coldStarts, avg(@initDuration) as avgInitMs, max(@initDuration) as maxInitMs
   ```
   Result: 38 cold starts out of 100 invocations. `avgInitMs: 1,840ms`, `maxInitMs: 2,910ms`.

2. The custom EMF `ColdStart` metric filter confirmed this — 38 events in the 10-minute window.

3. Ran the same query filtered to non-cold invocations:
   - avg duration (warm): 1,620ms
   - avg duration (cold): 4,210ms
   That 2,590ms gap is almost entirely SDK initialization at 512 MB.

4. Checked AWS Lambda docs: at 512 MB, Node.js cold start for AWS SDK v3 is typically 1,500–2,500ms. At 1024 MB, 600–900ms. The CPU allocation scales linearly with memory.

**Fix**: Bumped processor memory to 1024 MB. Re-ran 100-image benchmark. Cold start duration dropped from avg 1,840ms to avg 820ms. p99 dropped from 9,400ms to 5,180ms.

**Not fully fixed**: Cold starts still happen — frequency is the same (38%), only duration dropped. Provisioned concurrency (5 instances) would eliminate cold starts entirely at $0.015/hour. Deferred — not worth it below ~500 images/hour.

---

## INV-002 — 2025-04-28: Duplicate Rekognition calls on S3 event retry

**Trigger**: While testing with 50 images, checked DynamoDB and found 5 images with `retryCount: 0` but two entries in CloudWatch showing `Processing image` logs for the same `imageId` within 3 seconds of each other.

**Investigation**:
1. CloudWatch Logs Insights:
   ```
   fields imageId, @timestamp, message
   | filter message = "Processing image"
   | stats count() as invocations by imageId
   | filter invocations > 1
   ```
   Result: 5 imageIds with 2 invocations each. All within a 2–4 second window.

2. Checked S3 event notification logs. S3 documentation confirms: ObjectCreated notifications are delivered at least once, not exactly once. When a Lambda response is slow (> ~3s), S3 can retry the notification.

3. No idempotency check existed — both invocations called `rekognition.DetectLabels` and both attempted a DynamoDB write. The second write overwrote the first with identical data (harmless but wasteful).

4. Cost impact: at $0.001/image, 5 duplicate calls on a 50-image run = $0.005 wasted = 10% cost overrun. At 100,000 images with 10% duplicate rate that is $100 wasted.

**Fix**: Added DynamoDB Idempotency table. Conditional write on `bucket::key::etag`. Second invocation gets `ConditionalCheckFailedException`, returns immediately, no Rekognition call. Re-ran same 50-image scenario — 0 duplicate invocations.

---

## INV-001 — 2025-04-22: EventBridge Pipes forwarding noise events to Analytics

**Trigger**: After wiring up EventBridge Pipes, noticed the Analytics Aggregator Lambda was being invoked 4x per image instead of 1x. CloudWatch invocation count showed 200 Analytics invocations for a 50-image run.

**Investigation**:
1. Checked EventBridge Pipe source config — no filter was set. Every DynamoDB stream event (INSERT on PENDING, MODIFY on PROCESSING, MODIFY on PROCESSED, MODIFY on FAILED) was being forwarded.

2. Analytics Aggregator only has useful work to do on `status=PROCESSED`. The other three transitions produce no actionable output — the function short-circuits and returns immediately.

3. Cost impact: 150 unnecessary Lambda invocations per 50 images. At $0.0000002/request that is $0.00003 — negligible now, but at 1M images/month it is $3,000 in unnecessary invocations (150 * 20,000 batches).

4. Lambda duration cost: each no-op invocation still ran for ~50ms consuming 512 MB = 0.025 GB-seconds. 150 * 0.025 * $0.0000166667 = $0.000063 per 50 images → $1.26/million images in pure waste.

**Fix**: Added `filterCriteria` to the Analytics Pipe targeting `dynamodb.NewImage.status.S = ["PROCESSED"]`. Invocations dropped to 1x per image. Verified in CloudWatch — 50 invocations for a 50-image run.

---

## INV-000 — 2025-04-20: Why pre-signed S3 URL instead of streaming through Lambda

**Question before building**: Should images be uploaded through Lambda (multipart stream) or directly to S3 via pre-signed URL?

**Analysis**:
1. Lambda payload limit: 6 MB synchronous, 256 KB for async event sources. A 10 MB JPEG would fail immediately.
2. Even under 6 MB: routing through Lambda means the image bytes transit Lambda memory, increasing memory pressure and duration. A 5 MB image at 256 MB Lambda = Lambda holds the full buffer in memory during the request.
3. Pre-signed URL: Lambda generates a 300-second signed URL ($0.0000002), browser PUTs directly to S3 ($0.0000005). Zero image bytes touch Lambda. Lambda memory stays free for SDK calls.
4. Upload latency: browser → S3 direct is faster than browser → API GW → Lambda → S3. One fewer network hop, no Lambda cold start in the upload path.

**Decision**: Pre-signed URL. Lambda is only in the control plane (generate URL), not the data plane (image bytes).
