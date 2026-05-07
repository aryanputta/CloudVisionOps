# Benchmark Report

## Setup

| Parameter | Value |
|-----------|-------|
| AWS Region | us-east-1 |
| Lambda Memory (Processor) | 1024 MB (tuned from 512 MB in Round 3) |
| Lambda Timeout | 60s |
| Rekognition MaxLabels | 20 |
| Rekognition MinConfidence | 70% |
| DynamoDB Billing | On-Demand |
| Duplicate Detection | Enabled (imageHash GSI) |
| Idempotency | DynamoDB conditional write |
| Concurrent Workers | 10 |

---

## Round 1 — Baseline (2025-04-22)

512 MB Lambda, no idempotency, no dedup, no structured errors.

```
Batch: 50 images | Workers: 5 | Memory: 512 MB
```

| Metric | Value |
|--------|-------|
| avg latency | 3,810ms |
| p50 latency | 3,290ms |
| p95 latency | 6,180ms |
| p99 latency | 9,400ms |
| min latency | 1,140ms |
| max latency | 11,200ms |
| Throughput | 1.3 img/s |
| Success rate | 94% |
| Failure rate | 6% |
| Duplicate Rekognition calls | ~10% (S3 retry events) |
| Cold start rate | 38% |
| Avg cold start init duration | 1,840ms |
| Total cost (50 images) | $0.073 |
| Cost per 1,000 images | $1.46 |

**What the data showed**: p99 was 2.5x the p50. Pulled CloudWatch — 38% of invocations had `initDuration > 0`. Cold starts were driving the entire p99 tail. Separately, 5 images had two `Processing image` log entries within 3 seconds — S3 duplicate event delivery, both invoking Rekognition.

---

## Round 2 — Idempotency + DLQ (2025-04-28)

Added DynamoDB idempotency table, SQS FIFO DLQ, structured errors, DLQ Replay Lambda.

```
Batch: 50 images | Workers: 5 | Memory: 512 MB
```

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Duplicate Rekognition calls | 10% | 0% | -100% |
| Unrecoverable failures | 6% | 0% | -100% |
| Cost per 1,000 images | $1.46 | $1.41 | -3.4% |
| Error debuggability | 0 error types | 6 error types | — |

Failure recovery: 3 images were in FAILED state after a transient Rekognition 500. Triggered DLQ Replay. All 3 reached PROCESSED within 45 seconds. `replaySource: DLQ_REPLAY` confirmed in DynamoDB.

**Latency unchanged** — idempotency adds one DynamoDB write (~5ms) but no meaningful latency impact. Cold start problem still present.

---

## Round 3 — Memory Tuning + EventBridge Filtering (2025-05-03)

Bumped processor to 1024 MB. Added `status=PROCESSED` EventBridge filter.

```
Batch: 100 images | Workers: 10 | Memory: 1024 MB
```

| Metric | Round 1 | Round 3 | Delta |
|--------|---------|---------|-------|
| avg latency | 3,810ms | 2,040ms | -46% |
| p50 latency | 3,290ms | 1,760ms | -46% |
| p95 latency | 6,180ms | 3,140ms | -49% |
| p99 latency | 9,400ms | 5,180ms | -45% |
| min latency | 1,140ms | 680ms | -40% |
| max latency | 11,200ms | 6,910ms | -38% |
| Throughput | 1.3 img/s | 2.4 img/s | +85% |
| Avg cold start init duration | 1,840ms | 820ms | -55% |
| Analytics Lambda invocations per image | 4 | 1 | -75% |
| Lambda cost per 1,000 images | $0.034 | $0.037 | +9% |
| Total cost per 1,000 images | $1.41 | $1.38 | -2% |

**What the numbers mean**: Cold start init duration dropped from 1,840ms to 820ms — the 1024 MB CPU allocation initializes the AWS SDK roughly twice as fast. The EventBridge filter cut Analytics invocations from 4x to 1x per image. p95 under 3.2 seconds is acceptable for an async pipeline where the user is not waiting synchronously.

**Still not fixed**: Cold start *frequency* is the same (38%). Provisioned concurrency would fix this. Not deployed at this scale.

---

## Duplicate Detection Results

From a 200-image run with 20% duplicates injected (every 5th image was identical):

| Metric | Value |
|--------|-------|
| Duplicates detected | 40/40 (100% accuracy) |
| Rekognition calls avoided | 40 |
| Cost saved | $0.040 |
| Avg latency for DUPLICATE status | 310ms (no Rekognition call) |
| Avg latency for PROCESSED status | 2,040ms |

The DUPLICATE path is 6.6x faster because it exits after the DynamoDB hash lookup with no Rekognition call.

---

## DLQ Replay Results

3-image replay from Round 2 transient failure:

| imageId | Original error | Replay outcome | Replay latency |
|---------|---------------|----------------|----------------|
| abc-001 | REKOGNITION_ERROR | PROCESSED | 1,820ms |
| abc-002 | REKOGNITION_ERROR | PROCESSED | 2,140ms |
| abc-003 | TIMEOUT_ERROR | PROCESSED | 1,960ms |

All three confirmed via DynamoDB: `replaySource: "DLQ_REPLAY"`, `retryCount: 1`.

---

## What Would Change at 1,000 Images

Based on Round 3 numbers, extrapolated:

| Metric | Projection |
|--------|------------|
| Total cost | ~$1.38 |
| Cost per image | ~$0.00138 |
| Rekognition savings at 20% dup rate | ~$0.040 |
| Expected p95 (warm Lambdas after first 50) | ~2,100ms |
| Expected p95 (cold start batch, burst) | ~4,800ms |
| DLQ messages at 1% failure rate | ~10 |

Actual 1,000-image results: run `python3 benchmarks/upload_benchmark.py --batch 1000 --workers 20` after deploy and update this table.
