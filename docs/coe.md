# Corrections of Error (COE)

Amazon's post-mortem format. Every incident that causes data loss, incorrect processing, or customer-visible failures gets a COE. The purpose is to find systemic causes, not assign blame.

---

## COE-001 — Duplicate Rekognition Invocations on S3 Event Retry

**Date**: 2025-04-22
**Severity**: Medium
**Duration**: Present from initial deploy until 2025-04-28 (6 days)
**Impact**: ~10% of images triggered two Rekognition calls instead of one. No data was lost or corrupted — second write overwrote first with identical data. Cost impact: ~10% Rekognition cost overrun on all runs during this period.

---

### Timeline

| Time | Event |
|------|-------|
| 2025-04-22 18:00 | Initial deploy. No idempotency layer. |
| 2025-04-22 18:45 | First 50-image test run. Appeared successful. |
| 2025-04-25 14:00 | Reviewing CloudWatch logs. Noticed 5 imageIds with two "Processing image" entries within 3 seconds of each other. |
| 2025-04-25 14:20 | Confirmed: S3 delivered duplicate ObjectCreated events on 5 images. Both invocations ran Rekognition and wrote to DynamoDB. |
| 2025-04-25 14:30 | Checked AWS documentation. S3 event notifications are "at least once" delivery. This is expected behavior, not a bug. |
| 2025-04-28 11:00 | DynamoDB idempotency table + conditional write deployed. |
| 2025-04-28 11:30 | Re-ran 50-image test. Zero duplicate invocations confirmed in CloudWatch. |

---

### Root Cause

S3 event notifications are at-least-once delivery. When the Rekognition processor Lambda responded slowly (> ~3 seconds, typically on cold starts), S3 retried the notification delivery. The system had no mechanism to detect or suppress the duplicate invocation.

**Why wasn't this caught before deploy?**
Unit tests mocked S3 events — a single event per test. No test simulated S3 sending the same event twice. The condition only surfaces under real S3 behavior with slow Lambda responses.

**Why did Lambda respond slowly enough to trigger S3 retry?**
512 MB cold start init duration averaged 1,840ms. Combined with Rekognition call (~1,500ms), first invocations regularly exceeded 3 seconds — the apparent threshold at which S3 retried.

---

### Five Whys

1. **Why** were duplicate Rekognition calls made? — Both S3 event deliveries triggered full Lambda execution with no duplicate check.
2. **Why** was there no duplicate check? — Initial design assumed S3 events were exactly-once. They are at-least-once.
3. **Why** was this assumption made? — S3 documentation states "at least once" but the retry behavior is not obvious without reading the fine print.
4. **Why** wasn't this caught in testing? — Test suite only tested single event delivery. No test for duplicate S3 event delivery existed.
5. **Why** didn't the second invocation fail visibly? — DynamoDB PutItem with no condition overwrites silently. No error, no log entry — the duplicate was invisible.

---

### Impact

- **User impact**: None. Images were processed correctly. Users did not see duplicates.
- **Data impact**: None. Second DynamoDB write was idempotent (same data).
- **Cost impact**: ~$0.005 per 50-image run (5 duplicate Rekognition calls × $0.001). At 1M images/month with 10% duplicate rate: $1,000/month overrun.
- **Operational impact**: Logs were noisy — two "Processing image" entries per affected image made tracing confusing.

---

### Resolution

Added DynamoDB Idempotency table. Conditional write on `bucket::key::etag`:
```typescript
await ddb.send(new PutCommand({
  TableName: table,
  Item: { idempotencyKey, expiry, createdAt: ... },
  ConditionExpression: 'attribute_not_exists(idempotencyKey)',
}));
```
If `ConditionalCheckFailedException` is thrown, the invocation returns immediately — no Rekognition call, no DynamoDB write, no cost.

TTL of 24 hours on idempotency records ensures the table does not grow unbounded.

---

### Action Items

| Action | Owner | Status |
|--------|-------|--------|
| Add DynamoDB idempotency table + conditional write | Engineering | Done — deployed 2025-04-28 |
| Add reliability test: duplicate S3 event delivery | Engineering | Done — `tests/reliability/failureScenarios.test.ts` |
| Add CloudWatch Logs Insights query to runbook for detecting duplicate invocations | Engineering | Done — `docs/runbook.md` |
| Document S3 at-least-once delivery behavior in system design | Engineering | Done — `docs/system_design.md` weaknesses section |

---

### Lessons Learned

1. **AWS service delivery guarantees are not always what you expect.** SQS standard is at-least-once. S3 notifications are at-least-once. EventBridge is at-least-once. DynamoDB Streams are at-least-once. The only service in this stack with exactly-once delivery is SQS FIFO with content-based deduplication.

2. **Silent DynamoDB overwrites hide bugs.** A PutItem that succeeds twice looks identical to one that succeeded once. Add `ConditionExpression` to any write where duplicate execution would be harmful.

3. **Cold starts amplify at-least-once delivery problems.** The duplicate events only occurred when Lambda was slow enough to trigger S3 retry. Fixing cold starts (Round 3 memory tuning) reduced the window where duplicates could occur, but idempotency is the correct fix — not performance.

4. **Tests should simulate actual AWS delivery behavior.** Add at least one test per event source that delivers the same event twice and verifies the system handles it correctly.

---

## COE Template (for future incidents)

```
## COE-NNN — [Title]

**Date**:
**Severity**: Low / Medium / High / Critical
**Duration**:
**Impact**:

### Timeline

### Root Cause

### Five Whys

### Impact

### Resolution

### Action Items

### Lessons Learned
```
