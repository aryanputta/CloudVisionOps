# AWS Cost Breakdown

Region: us-east-1 | Pricing as of 2024

---

## Per-Service Cost Model

### Amazon Rekognition
| Operation | Price | Notes |
|-----------|-------|-------|
| DetectLabels (first 1M images/month) | $0.0010 / image | Most significant cost driver |
| DetectLabels (1M-10M images/month) | $0.0008 / image | Tiered pricing |
| DetectModerationLabels | $0.0010 / image | Optional — moderation layer |

### AWS Lambda
| Metric | Price |
|--------|-------|
| Requests | $0.20 per 1M requests ($0.0000002 each) |
| Duration (1024 MB) | $0.0000166667 per GB-second |
| Duration (256 MB) | $0.0000166667 per GB-second (lower cost) |
| Free tier | 1M requests + 400,000 GB-seconds/month |

### Amazon DynamoDB (on-demand)
| Operation | Price |
|-----------|-------|
| Write Request Unit | $0.00000125 |
| Read Request Unit | $0.00000025 |
| Storage | $0.25 per GB/month |
| Streams reads | $0.02 per 100,000 reads |

### Amazon S3
| Operation | Price |
|-----------|-------|
| PUT request | $0.0000005 |
| GET request | $0.0000004 |
| Storage (standard) | $0.023 per GB/month |
| Intelligent-Tiering | ~18% lower after 30 days |

### Amazon API Gateway (REST API)
| | Price |
|-|-------|
| First 333M requests/month | $3.50 per 1M |
| Data transfer | $0.09 per GB |

### Amazon SQS
| | Price |
|-|-------|
| First 1M requests/month | Free |
| After 1M | $0.40 per 1M requests |
| FIFO queue | $0.50 per 1M requests |

### AWS X-Ray
| | Price |
|-|-------|
| First 100k traces/month | Free |
| After 100k | $5.00 per 1M traces |

---

## Cost Per Batch Size

Assumptions:
- Lambda processor: 1024 MB, avg 2s duration per image
- 2 DynamoDB writes per image (PENDING + result)
- 1 DynamoDB read per image (duplicate check)
- 1 S3 PUT per image
- 1 API Gateway request per image

| Images | Rekognition | Lambda | DynamoDB | S3 | API GW | Total | Per Image |
|--------|-------------|--------|----------|----|--------|-------|-----------|
| 100 | $0.10 | $0.034 | $0.0003 | $0.00005 | $0.00035 | $0.135 | $0.00135 |
| 1,000 | $1.00 | $0.34 | $0.003 | $0.0005 | $0.0035 | $1.347 | $0.00135 |
| 10,000 | $10.00 | $3.40 | $0.03 | $0.005 | $0.035 | $13.47 | $0.00135 |
| 100,000 | $100.00 | $34.00 | $0.30 | $0.05 | $0.35 | $134.70 | $0.00135 |
| 1,000,000 | $800.00* | $340.00 | $3.00 | $0.50 | $3.50 | $1,147.00 | $0.00115 |

*Tiered Rekognition pricing applies at 1M+.

---

## Cost Savings from Duplicate Detection

Each DUPLICATE detection avoids one Rekognition call ($0.001) and one Lambda full execution (~$0.034 for 1000 images).

| Duplicate Rate | Per 1,000 Images | Per 10,000 Images | Per 100,000 Images |
|----------------|------------------|-------------------|--------------------|
| 5% duplicates | $0.052 saved | $0.52 saved | $5.20 saved |
| 10% duplicates | $0.105 saved | $1.05 saved | $10.50 saved |
| 20% duplicates | $0.210 saved | $2.10 saved | $21.00 saved |
| 30% duplicates | $0.315 saved | $3.15 saved | $31.50 saved |

---

## Lambda Memory Optimization

| Memory | Avg Duration | GB-seconds | Cost/1000 | Speedup |
|--------|-------------|-----------|-----------|---------|
| 512 MB | 3.8s | 1.95 | $0.0325 | baseline |
| 1024 MB | 2.1s | 2.15 | $0.0358 | 1.8x faster |
| 2048 MB | 1.3s | 2.67 | $0.0445 | 2.9x faster |
| 3008 MB | 1.0s | 3.00 | $0.0500 | 3.8x faster |

Recommendation: **1024 MB** is the optimal tradeoff — nearly 2x speedup at only 10% more cost vs 512 MB.
For latency-sensitive prod workloads, **2048 MB** with provisioned concurrency eliminates cold starts.

---

## Retry Cost Impact

Each retry adds one Rekognition call + one Lambda invocation.

| Retry Rate | Extra Cost per 1,000 Images |
|------------|---------------------------|
| 5% retry | $0.07 |
| 10% retry | $0.14 |
| 20% retry | $0.27 |

The SQS FIFO DLQ `maxReceiveCount: 3` caps retry exposure at 3x per failed job.

---

## Monthly Cost Projection (1M images/month)

| Service | Cost |
|---------|------|
| Rekognition | $800.00 (tiered) |
| Lambda | $340.00 |
| DynamoDB | $3.00 |
| S3 (requests + 50 GB storage) | $1.65 |
| API Gateway | $3.50 |
| SQS | $0.50 |
| CloudWatch | $5.00 |
| X-Ray | $5.00 |
| **Total** | **~$1,158.65/month** |
| **Per image** | **~$0.00116** |

With 20% duplicate detection: ~$1,121/month (saves ~$37/month).
With Lambda right-sizing + dedup: potential 15-20% total reduction.
