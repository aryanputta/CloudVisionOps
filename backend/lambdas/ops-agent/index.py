"""
CloudVisionOps Autonomous Operations Agent

Reads DynamoDB and CloudWatch metrics, classifies operational anomalies,
and writes structured recommendations to the OpsRecommendations table.
Runs every 15 minutes via EventBridge scheduled rule.
"""

import json
import os
import uuid
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import boto3
from boto3.dynamodb.conditions import Key, Attr

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

# ---- Clients ----

dynamodb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1"))
cloudwatch = boto3.client("cloudwatch", region_name=os.environ.get("AWS_REGION", "us-east-1"))
sns_client = boto3.client("sns", region_name=os.environ.get("AWS_REGION", "us-east-1"))

# ---- Config ----

IMAGE_TABLE = os.environ["IMAGE_METADATA_TABLE"]
OPS_TABLE = os.environ["OPS_RECOMMENDATIONS_TABLE"]
ALERT_TOPIC = os.environ["ALERT_TOPIC_ARN"]

LATENCY_SPIKE_THRESHOLD_MS = float(os.environ.get("LATENCY_SPIKE_THRESHOLD_MS", "5000"))
HIGH_FAILURE_RATE_THRESHOLD = float(os.environ.get("HIGH_FAILURE_RATE_THRESHOLD", "0.05"))
DLQ_BACKLOG_THRESHOLD = int(os.environ.get("DLQ_BACKLOG_THRESHOLD", "50"))
DUPLICATE_SURGE_THRESHOLD = float(os.environ.get("DUPLICATE_SURGE_THRESHOLD", "0.30"))
LOW_CONFIDENCE_THRESHOLD = float(os.environ.get("LOW_CONFIDENCE_THRESHOLD", "75"))
COST_SPIKE_THRESHOLD_PERCENT = float(os.environ.get("COST_SPIKE_THRESHOLD_PERCENT", "20"))

# Recommendation categories
CATEGORIES = {
    "LATENCY_SPIKE": "HIGH",
    "COST_RISK": "MEDIUM",
    "HIGH_FAILURE_RATE": "HIGH",
    "DUPLICATE_SURGE": "MEDIUM",
    "LOW_CONFIDENCE_LABELS": "LOW",
    "HOT_PARTITION_RISK": "MEDIUM",
    "DLQ_BACKLOG": "HIGH",
    "SCALING_WARNING": "MEDIUM",
}


def handler(event, context):
    logger.info("Ops agent starting analysis")
    now = datetime.now(timezone.utc)
    analysis_window_start = now - timedelta(hours=1)

    recommendations = []

    try:
        # 1. Latency spike detection
        latency_recs = analyze_latency(analysis_window_start)
        recommendations.extend(latency_recs)

        # 2. Failure rate analysis
        failure_recs = analyze_failure_rate(analysis_window_start)
        recommendations.extend(failure_recs)

        # 3. Duplicate surge detection
        duplicate_recs = analyze_duplicate_rate(analysis_window_start)
        recommendations.extend(duplicate_recs)

        # 4. DLQ backlog check
        dlq_recs = analyze_dlq_backlog()
        recommendations.extend(dlq_recs)

        # 5. Low confidence label detection
        confidence_recs = analyze_low_confidence(analysis_window_start)
        recommendations.extend(confidence_recs)

        # 6. Lambda cold start analysis via CloudWatch
        coldstart_recs = analyze_cold_starts(now)
        recommendations.extend(coldstart_recs)

        # 7. DynamoDB hot partition detection
        partition_recs = analyze_hot_partitions(analysis_window_start)
        recommendations.extend(partition_recs)

        # Write all recommendations to DynamoDB
        write_recommendations(recommendations, now)

        # Alert on HIGH severity recommendations
        high_severity = [r for r in recommendations if r["severity"] == "HIGH"]
        if high_severity:
            publish_alert(high_severity, now)

        logger.info(
            "Ops agent analysis complete",
            extra={"totalRecommendations": len(recommendations), "highSeverity": len(high_severity)},
        )
        return {"statusCode": 200, "recommendations": len(recommendations)}

    except Exception as e:
        logger.error(f"Ops agent failed: {e}", exc_info=True)
        return {"statusCode": 500, "error": str(e)}


def analyze_latency(since: datetime) -> list:
    recommendations = []
    table = dynamodb.Table(IMAGE_TABLE)

    # Query PROCESSED images from the last hour
    result = table.query(
        IndexName="status-updatedAt-index",
        KeyConditionExpression=Key("status").eq("PROCESSED") & Key("updatedAt").gte(since.isoformat()),
        Limit=200,
    )

    items = result.get("Items", [])
    if not items:
        return recommendations

    latencies = [item.get("processingLatencyMs", 0) for item in items if item.get("processingLatencyMs")]

    if not latencies:
        return recommendations

    avg_latency = sum(latencies) / len(latencies)
    sorted_latencies = sorted(latencies)
    p95 = sorted_latencies[int(len(sorted_latencies) * 0.95)] if len(sorted_latencies) > 1 else sorted_latencies[-1]
    p99 = sorted_latencies[int(len(sorted_latencies) * 0.99)] if len(sorted_latencies) > 1 else sorted_latencies[-1]

    if p95 > LATENCY_SPIKE_THRESHOLD_MS:
        recommendations.append({
            "category": "LATENCY_SPIKE",
            "severity": "HIGH",
            "sourceMetric": f"p95_latency={p95:.0f}ms",
            "description": f"P95 processing latency is {p95:.0f}ms, exceeding threshold of {LATENCY_SPIKE_THRESHOLD_MS:.0f}ms",
            "recommendedAction": (
                "1. Increase Lambda memory to 2048 MB (reduces cold start duration and speeds I/O)\n"
                "2. Enable Lambda provisioned concurrency if traffic is predictable\n"
                "3. Check Rekognition service health dashboard for regional issues\n"
                "4. Consider enabling X-Ray active tracing to identify bottleneck"
            ),
            "confidence": 0.90,
            "metrics": {"avgMs": round(avg_latency), "p95Ms": round(p95), "p99Ms": round(p99), "sampleSize": len(latencies)},
        })
    return recommendations


def analyze_failure_rate(since: datetime) -> list:
    recommendations = []
    table = dynamodb.Table(IMAGE_TABLE)

    failed = table.query(
        IndexName="status-updatedAt-index",
        KeyConditionExpression=Key("status").eq("FAILED") & Key("updatedAt").gte(since.isoformat()),
        Select="COUNT",
    ).get("Count", 0)

    processed = table.query(
        IndexName="status-updatedAt-index",
        KeyConditionExpression=Key("status").eq("PROCESSED") & Key("updatedAt").gte(since.isoformat()),
        Select="COUNT",
    ).get("Count", 0)

    total = failed + processed
    if total == 0:
        return recommendations

    failure_rate = failed / total

    if failure_rate > HIGH_FAILURE_RATE_THRESHOLD:
        # Classify the dominant error type
        failed_items = table.query(
            IndexName="status-updatedAt-index",
            KeyConditionExpression=Key("status").eq("FAILED") & Key("updatedAt").gte(since.isoformat()),
            Limit=50,
        ).get("Items", [])

        error_counts: dict = {}
        for item in failed_items:
            etype = item.get("errorType", "UNKNOWN")
            error_counts[etype] = error_counts.get(etype, 0) + 1

        dominant_error = max(error_counts, key=error_counts.get) if error_counts else "UNKNOWN"

        action_map = {
            "S3_READ_ERROR": "Check S3 bucket policy and object ACLs. Verify Lambda execution role has s3:GetObject permission.",
            "REKOGNITION_ERROR": "Check Rekognition service limits. Verify image format. Consider adding image validation before Rekognition call.",
            "DYNAMODB_WRITE_ERROR": "Check DynamoDB table capacity. Enable auto-scaling or switch to on-demand billing.",
            "TIMEOUT_ERROR": "Increase Lambda timeout. Check if Rekognition API latency has increased. Add circuit breaker.",
        }

        recommendations.append({
            "category": "HIGH_FAILURE_RATE",
            "severity": "HIGH",
            "sourceMetric": f"failure_rate={failure_rate:.2%}",
            "description": f"Failure rate is {failure_rate:.2%} over the last hour ({failed} of {total} images). Dominant error: {dominant_error}",
            "recommendedAction": action_map.get(dominant_error, "Investigate error logs. Check downstream service health."),
            "confidence": 0.92,
            "metrics": {"failureRate": round(failure_rate, 4), "failed": failed, "total": total, "dominantError": dominant_error, "errorBreakdown": error_counts},
        })

    return recommendations


def analyze_duplicate_rate(since: datetime) -> list:
    recommendations = []
    table = dynamodb.Table(IMAGE_TABLE)

    duplicates = table.query(
        IndexName="status-updatedAt-index",
        KeyConditionExpression=Key("status").eq("DUPLICATE") & Key("updatedAt").gte(since.isoformat()),
        Select="COUNT",
    ).get("Count", 0)

    processed = table.query(
        IndexName="status-updatedAt-index",
        KeyConditionExpression=Key("status").eq("PROCESSED") & Key("updatedAt").gte(since.isoformat()),
        Select="COUNT",
    ).get("Count", 0)

    total = duplicates + processed
    if total == 0:
        return recommendations

    duplicate_rate = duplicates / total

    if duplicate_rate > DUPLICATE_SURGE_THRESHOLD:
        saved_cost = duplicates * 0.001  # $0.001 per Rekognition call saved
        recommendations.append({
            "category": "DUPLICATE_SURGE",
            "severity": "MEDIUM",
            "sourceMetric": f"duplicate_rate={duplicate_rate:.2%}",
            "description": f"Duplicate upload rate is {duplicate_rate:.2%} ({duplicates} duplicates in last hour). Saving ~${saved_cost:.4f} in Rekognition costs.",
            "recommendedAction": (
                "High duplicate rate may indicate client-side retry storm or misconfigured upload logic.\n"
                "1. Add client-side deduplication (cache uploaded image hashes)\n"
                "2. Implement exponential backoff on frontend upload retries\n"
                "3. Consider pre-upload duplicate check via API before generating presigned URL"
            ),
            "confidence": 0.85,
            "metrics": {"duplicateRate": round(duplicate_rate, 4), "duplicates": duplicates, "savedCostUsd": round(saved_cost, 6)},
        })

    return recommendations


def analyze_dlq_backlog() -> list:
    recommendations = []

    # Use CloudWatch to check DLQ approximate message count
    try:
        stage = os.environ.get("STAGE", "dev")
        response = cloudwatch.get_metric_statistics(
            Namespace="AWS/SQS",
            MetricName="ApproximateNumberOfMessagesVisible",
            Dimensions=[{"Name": "QueueName", "Value": f"CloudVisionOps-DLQ-{stage}"}],
            StartTime=datetime.now(timezone.utc) - timedelta(minutes=5),
            EndTime=datetime.now(timezone.utc),
            Period=300,
            Statistics=["Maximum"],
        )

        datapoints = response.get("Datapoints", [])
        if not datapoints:
            return recommendations

        max_depth = max(dp["Maximum"] for dp in datapoints)

        if max_depth >= DLQ_BACKLOG_THRESHOLD:
            recommendations.append({
                "category": "DLQ_BACKLOG",
                "severity": "HIGH",
                "sourceMetric": f"dlq_depth={max_depth:.0f}",
                "description": f"DLQ contains {max_depth:.0f} messages, exceeding threshold of {DLQ_BACKLOG_THRESHOLD}",
                "recommendedAction": (
                    "1. Trigger DLQ replay Lambda via POST /replay API endpoint\n"
                    "2. Review failure patterns in failed image metadata\n"
                    "3. If error is systemic (e.g., S3 bucket policy), fix root cause before replaying\n"
                    "4. Consider increasing maxReceiveCount on processing queue for transient errors"
                ),
                "confidence": 0.99,
                "metrics": {"dlqDepth": max_depth},
            })
    except Exception as e:
        logger.warning(f"DLQ metric check failed: {e}")

    return recommendations


def analyze_low_confidence(since: datetime) -> list:
    recommendations = []
    table = dynamodb.Table(IMAGE_TABLE)

    result = table.query(
        IndexName="status-updatedAt-index",
        KeyConditionExpression=Key("status").eq("PROCESSED") & Key("updatedAt").gte(since.isoformat()),
        FilterExpression=Attr("confidenceScore").lt(LOW_CONFIDENCE_THRESHOLD),
        Limit=200,
    )

    low_confidence_items = result.get("Items", [])
    if len(low_confidence_items) > 5:
        avg_conf = sum(i.get("confidenceScore", 0) for i in low_confidence_items) / len(low_confidence_items)
        recommendations.append({
            "category": "LOW_CONFIDENCE_LABELS",
            "severity": "LOW",
            "sourceMetric": f"low_confidence_count={len(low_confidence_items)}",
            "description": f"{len(low_confidence_items)} images processed with confidence below {LOW_CONFIDENCE_THRESHOLD}%. Average confidence: {avg_conf:.1f}%",
            "recommendedAction": (
                "1. Consider lowering REKOGNITION_MIN_CONFIDENCE to improve label coverage\n"
                "2. Review image quality — blurry/small images produce low confidence scores\n"
                "3. Add image preprocessing (resize, normalize) before Rekognition call\n"
                "4. Flag these images for manual review if they represent a critical category"
            ),
            "confidence": 0.75,
            "metrics": {"lowConfidenceCount": len(low_confidence_items), "avgConfidence": round(avg_conf, 2)},
        })

    return recommendations


def analyze_cold_starts(now: datetime) -> list:
    recommendations = []

    try:
        stage = os.environ.get("STAGE", "dev")
        response = cloudwatch.get_metric_statistics(
            Namespace="CloudVisionOps",
            MetricName="ColdStart",
            StartTime=now - timedelta(hours=1),
            EndTime=now,
            Period=3600,
            Statistics=["Sum"],
        )

        datapoints = response.get("Datapoints", [])
        if not datapoints:
            return recommendations

        cold_starts = sum(dp["Sum"] for dp in datapoints)

        if cold_starts > 20:
            recommendations.append({
                "category": "SCALING_WARNING",
                "severity": "MEDIUM",
                "sourceMetric": f"cold_starts={cold_starts:.0f}",
                "description": f"{cold_starts:.0f} Lambda cold starts detected in the last hour. This increases p99 latency.",
                "recommendedAction": (
                    "1. Enable Lambda provisioned concurrency for RekognitionProcessor (recommend: 5 instances)\n"
                    "2. Increase Lambda memory from 1024 MB to 2048 MB — reduces init duration\n"
                    "3. Use Lambda SnapStart (Java) or container image caching for faster init\n"
                    "4. Consider connection pooling to avoid SDK re-initialization on cold starts"
                ),
                "confidence": 0.80,
                "metrics": {"coldStarts": int(cold_starts)},
            })
    except Exception as e:
        logger.warning(f"Cold start analysis failed: {e}")

    return recommendations


def analyze_hot_partitions(since: datetime) -> list:
    """
    Detects potential hot partitions by checking if a single userId or dominantLabel
    accounts for a disproportionate fraction of writes.
    """
    recommendations = []
    table = dynamodb.Table(IMAGE_TABLE)

    result = table.query(
        IndexName="status-updatedAt-index",
        KeyConditionExpression=Key("status").eq("PROCESSED") & Key("updatedAt").gte(since.isoformat()),
        ProjectionExpression="userId, dominantLabel",
        Limit=200,
    )

    items = result.get("Items", [])
    if len(items) < 10:
        return recommendations

    user_counts: dict = {}
    for item in items:
        uid = item.get("userId", "anonymous")
        user_counts[uid] = user_counts.get(uid, 0) + 1

    max_user_count = max(user_counts.values())
    max_user_fraction = max_user_count / len(items)

    # If one user accounts for >50% of writes, partition key distribution is skewed
    if max_user_fraction > 0.5:
        hot_user = max(user_counts, key=user_counts.get)
        recommendations.append({
            "category": "HOT_PARTITION_RISK",
            "severity": "MEDIUM",
            "sourceMetric": f"hot_user_fraction={max_user_fraction:.2%}",
            "description": f"User '{hot_user}' accounts for {max_user_fraction:.2%} of recent writes. userId-based GSI may become a hot partition.",
            "recommendedAction": (
                "1. Add write sharding: prefix userId with random shard key (e.g., 'shard#userId')\n"
                "2. Consider DynamoDB DAX if read patterns are also skewed\n"
                "3. Review if this is a single test/benchmark user — exclude from production metrics"
            ),
            "confidence": 0.70,
            "metrics": {"hotUser": hot_user, "fraction": round(max_user_fraction, 4), "totalSampled": len(items)},
        })

    return recommendations


def write_recommendations(recommendations: list, now: datetime) -> None:
    if not recommendations:
        return

    table = dynamodb.Table(OPS_TABLE)
    ts = now.isoformat()

    with table.batch_writer() as batch:
        for rec in recommendations:
            rec_id = str(uuid.uuid4())
            batch.put_item(Item={
                "recommendationId": rec_id,
                "timestamp": ts,
                "severity": rec.get("severity", "LOW"),
                "category": rec.get("category", "UNKNOWN"),
                "sourceMetric": rec.get("sourceMetric", ""),
                "description": rec.get("description", ""),
                "recommendedAction": rec.get("recommendedAction", ""),
                "confidence": str(rec.get("confidence", 0.5)),
                "status": "OPEN",
                "metrics": json.dumps(rec.get("metrics", {})),
                # TTL: auto-expire recommendations after 7 days
                "ttl": int(now.timestamp()) + 7 * 24 * 3600,
            })

    logger.info(f"Wrote {len(recommendations)} recommendations to {OPS_TABLE}")


def publish_alert(high_severity: list, now: datetime) -> None:
    try:
        sns_client.publish(
            TopicArn=ALERT_TOPIC,
            Subject="[CloudVisionOps] HIGH SEVERITY OPS RECOMMENDATIONS",
            Message=json.dumps({
                "event": "OPS_AGENT_ALERT",
                "severity": "HIGH",
                "count": len(high_severity),
                "recommendations": [
                    {
                        "category": r["category"],
                        "description": r["description"],
                        "recommendedAction": r["recommendedAction"][:200],
                    }
                    for r in high_severity
                ],
                "timestamp": now.isoformat(),
            }),
            MessageAttributes={
                "eventType": {"DataType": "String", "StringValue": "OPS_AGENT_ALERT"},
                "severity": {"DataType": "String", "StringValue": "HIGH"},
            },
        )
    except Exception as e:
        logger.error(f"Failed to publish alert: {e}")
