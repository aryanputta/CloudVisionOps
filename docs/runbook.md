# Operations Runbook

Procedures for every CloudWatch alarm in the monitoring stack. Each section covers: what the alarm means, how to diagnose it, and how to resolve it.

---

## Alarm: CloudVisionOps-DLQDepth

**Fires when**: DLQ `ApproximateNumberOfMessagesVisible` >= 50 for 2 consecutive minutes.

**What it means**: At least 50 processing jobs have failed all 3 retry attempts and are sitting unprocessed. New failures continue to accumulate.

**Do not replay immediately.** Replaying into an active outage refills the DLQ.

### Diagnosis

1. Check if Rekognition is healthy:
   ```
   aws health describe-events --filter eventTypeCategories=issue --region us-east-1
   ```

2. Pull the most recent DLQ messages (do not delete them):
   ```
   aws sqs receive-message \
     --queue-url <DLQ_URL> \
     --max-number-of-messages 10 \
     --message-attribute-names All \
     --visibility-timeout 0
   ```
   Look at `errorType` in the message body. If all messages share the same `errorType`, root cause is likely systemic.

3. Check Lambda error logs:
   ```
   aws logs filter-log-events \
     --log-group-name /aws/lambda/CloudVisionOps-RekognitionProcessor-dev \
     --start-time $(date -d '30 minutes ago' +%s000) \
     --filter-pattern '"FAILED"'
   ```

4. Check Rekognition processor error rate in CloudWatch:
   ```
   aws cloudwatch get-metric-statistics \
     --namespace AWS/Lambda \
     --metric-name Errors \
     --dimensions Name=FunctionName,Value=CloudVisionOps-RekognitionProcessor-dev \
     --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ) \
     --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
     --period 300 --statistics Sum
   ```

### Resolution

**If root cause is a transient AWS service error (Rekognition 500, DynamoDB throttle):**
1. Confirm the service is healthy again
2. Trigger DLQ replay in small batches:
   ```
   curl -X POST <API_BASE_URL>/replay
   ```
   Or invoke directly:
   ```
   aws lambda invoke \
     --function-name CloudVisionOps-DLQReplay-dev \
     --payload '{}' \
     response.json && cat response.json
   ```
3. Monitor DLQ depth — it should decrease. If it increases, stop and re-diagnose.

**If root cause is a code bug (VALIDATION_ERROR on all messages):**
1. Do not replay — replay will re-fail immediately
2. Fix the bug, deploy
3. Replay after fix is deployed

**If root cause is an S3_READ_ERROR (objects deleted from bucket):**
1. Objects cannot be recovered if bucket versioning was suspended
2. Mark affected images as permanently failed in DynamoDB:
   ```python
   # Update status to FAILED with errorType=S3_READ_ERROR_PERMANENT
   ```
3. Drain the DLQ by deleting those specific messages

---

## Alarm: CloudVisionOps-ProcessorErrorRate

**Fires when**: Lambda `Errors` metric > 10 in a 5-minute window, for 3 consecutive periods.

**What it means**: The Rekognition processor is failing at an elevated rate. At 50 images/minute, this represents > 20% failure rate.

### Diagnosis

1. Pull structured error logs:
   ```
   aws logs insights query \
     --log-group-name /aws/lambda/CloudVisionOps-RekognitionProcessor-dev \
     --start-time $(date -d '15 minutes ago' +%s) \
     --end-time $(date +%s) \
     --query-string 'fields errorType, errorMessage, imageId | filter level = "ERROR" | stats count() by errorType'
   ```

2. Check DynamoDB for error breakdown:
   ```
   aws dynamodb query \
     --table-name CloudVisionOps-ImageMetadata-dev \
     --index-name status-updatedAt-index \
     --key-condition-expression "#s = :s" \
     --expression-attribute-names '{"#s":"status"}' \
     --expression-attribute-values '{":s":{"S":"FAILED"}}' \
     --scan-index-forward false \
     --limit 20
   ```

### Resolution

| errorType | Resolution |
|-----------|-----------|
| REKOGNITION_ERROR | Check Rekognition service health. If healthy, check image format — invalid JPEGs produce this error. |
| S3_READ_ERROR | Check Lambda execution role has `s3:GetObject` on the upload bucket. Check bucket policy. |
| DYNAMODB_WRITE_ERROR | Check DynamoDB table for throttling. Switch to on-demand if provisioned capacity is exhausted. |
| TIMEOUT_ERROR | Lambda timeout is 60s. If Rekognition is slow, check regional latency. Consider increasing timeout to 90s. |
| VALIDATION_ERROR | Image failed format check before Rekognition. Check upload handler — file type validation may have been bypassed. |

---

## Alarm: CloudVisionOps-ProcessorDuration

**Fires when**: Lambda p95 duration > 5,000ms for 2 consecutive 5-minute periods.

**What it means**: Processing is slow. Likely causes: cold start spike, Rekognition latency increase, or DynamoDB write contention.

### Diagnosis

1. Check cold start rate:
   ```
   aws cloudwatch get-metric-statistics \
     --namespace CloudVisionOps \
     --metric-name ColdStart \
     --start-time $(date -u -d '30 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
     --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
     --period 300 --statistics Sum
   ```

2. Check Rekognition latency via X-Ray:
   ```
   aws xray get-service-graph \
     --start-time $(date -d '30 minutes ago' +%s) \
     --end-time $(date +%s)
   ```

3. Check if it correlates with a burst (many images uploaded at once → all Lambda instances cold):
   ```
   aws cloudwatch get-metric-statistics \
     --namespace AWS/Lambda \
     --metric-name Invocations \
     --dimensions Name=FunctionName,Value=CloudVisionOps-RekognitionProcessor-dev \
     --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ) \
     --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
     --period 60 --statistics Sum
   ```

### Resolution

**If cold starts are the cause:**
- Immediate: accept it — cold starts self-resolve as Lambda keeps instances warm
- Sustained fix: enable provisioned concurrency:
  ```
  aws lambda put-provisioned-concurrency-config \
    --function-name CloudVisionOps-RekognitionProcessor-dev \
    --qualifier <version_or_alias> \
    --provisioned-concurrent-executions 5
  ```
  Cost: ~$0.015/hour per instance × 5 = $1.80/day. Justify at > 500 images/hour sustained.

**If Rekognition latency is the cause:**
- Check AWS Service Health Dashboard
- Nothing actionable until Rekognition recovers

---

## Alarm: CloudVisionOps-ProcessorThrottles

**Fires when**: Lambda throttles >= 5 in a 1-minute window for 2 consecutive minutes.

**What it means**: Lambda concurrency limit hit. `reservedConcurrentExecutions: 50` was reached. New invocations are being throttled — S3 events are backing up.

### Resolution

1. Check current reserved concurrency:
   ```
   aws lambda get-function-concurrency \
     --function-name CloudVisionOps-RekognitionProcessor-dev
   ```

2. Decide: increase reserved concurrency or let it self-throttle.
   - Increasing to 100 costs nothing (Lambda has 1,000 default account limit)
   - Check account-level concurrent execution limit first:
     ```
     aws lambda get-account-settings
     ```
   - If below account limit, increase:
     ```
     aws lambda put-function-concurrency \
       --function-name CloudVisionOps-RekognitionProcessor-dev \
       --reserved-concurrent-executions 100
     ```

3. Root cause: if throttles are frequent, the upload rate has grown beyond the system's reserved capacity. Update CDK and redeploy.

---

## Alarm: CloudVisionOps-DynamoWriteThrottle

**Fires when**: DynamoDB `ThrottledRequests` for PutItem/UpdateItem > 10 in a 5-minute window.

**What it means**: Write throughput is being throttled. The table is on on-demand billing, so this should not happen unless a write burst exceeds the on-demand scaling capacity (which takes 30 seconds to scale up).

### Diagnosis

1. Check consumed WCUs:
   ```
   aws cloudwatch get-metric-statistics \
     --namespace AWS/DynamoDB \
     --metric-name ConsumedWriteCapacityUnits \
     --dimensions Name=TableName,Value=CloudVisionOps-ImageMetadata-dev \
     --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ) \
     --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
     --period 60 --statistics Sum
   ```

2. Check if a single partition key (userId) is driving all writes — hot partition. Pull from the Ops Agent recommendations table.

### Resolution

- On-demand billing auto-scales. If this is a one-time burst, wait 30–60 seconds.
- If sustained: investigate hot partition (single userId driving all writes) via Ops Agent recommendations.
- If hot partition confirmed: add write sharding prefix to userId keys in the upload handler.

---

## General Escalation Path

1. Alarm fires → SNS alert → on-call receives notification
2. Diagnose using queries above (< 10 minutes)
3. If root cause is clear and fix is low-risk → resolve immediately using steps above
4. If root cause is unclear or fix is high-risk → escalate, do not replay DLQ blindly
5. After resolution → write a COE entry in `docs/coe.md` if impact was > 5 minutes or > 50 images affected
