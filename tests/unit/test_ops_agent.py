"""
Unit tests for the CloudVisionOps ops agent.

Uses moto to mock AWS services — no real AWS calls are made.
Tests each anomaly detector independently with controlled DynamoDB state.
"""

import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch, MagicMock

import boto3
import pytest
from moto import mock_aws

# Set environment variables before importing the agent
os.environ["AWS_DEFAULT_REGION"] = "us-east-1"
os.environ["AWS_ACCESS_KEY_ID"] = "test"
os.environ["AWS_SECRET_ACCESS_KEY"] = "test"
os.environ["IMAGE_METADATA_TABLE"] = "test-image-metadata"
os.environ["OPS_RECOMMENDATIONS_TABLE"] = "test-ops-recommendations"
os.environ["ALERT_TOPIC_ARN"] = "arn:aws:sns:us-east-1:123456789012:test-alerts"
os.environ["STAGE"] = "test"
os.environ["LATENCY_SPIKE_THRESHOLD_MS"] = "3000"
os.environ["HIGH_FAILURE_RATE_THRESHOLD"] = "0.05"
os.environ["DLQ_BACKLOG_THRESHOLD"] = "10"
os.environ["DUPLICATE_SURGE_THRESHOLD"] = "0.20"
os.environ["LOW_CONFIDENCE_THRESHOLD"] = "75"

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../backend/lambdas/ops-agent"))
from index import (
    analyze_latency,
    analyze_failure_rate,
    analyze_duplicate_rate,
    analyze_low_confidence,
    analyze_hot_partitions,
    write_recommendations,
)


# ---- Fixtures ----

def make_table(dynamodb, table_name: str, gsis: list = None):
    kwargs = {
        "TableName": table_name,
        "KeySchema": [{"AttributeName": "imageId", "KeyType": "HASH"}],
        "AttributeDefinitions": [{"AttributeName": "imageId", "AttributeType": "S"}],
        "BillingMode": "PAY_PER_REQUEST",
    }
    if gsis:
        kwargs["GlobalSecondaryIndexes"] = gsis
        for gsi in gsis:
            for key in gsi["KeySchema"]:
                attr_name = key["AttributeName"]
                if not any(a["AttributeName"] == attr_name for a in kwargs["AttributeDefinitions"]):
                    kwargs["AttributeDefinitions"].append({"AttributeName": attr_name, "AttributeType": "S"})
    return dynamodb.create_table(**kwargs)


def make_image_table(dynamodb):
    return dynamodb.create_table(
        TableName="test-image-metadata",
        KeySchema=[{"AttributeName": "imageId", "KeyType": "HASH"}],
        AttributeDefinitions=[
            {"AttributeName": "imageId", "AttributeType": "S"},
            {"AttributeName": "status", "AttributeType": "S"},
            {"AttributeName": "updatedAt", "AttributeType": "S"},
            {"AttributeName": "userId", "AttributeType": "S"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "status-updatedAt-index",
                "KeySchema": [
                    {"AttributeName": "status", "KeyType": "HASH"},
                    {"AttributeName": "updatedAt", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            },
            {
                "IndexName": "userId-createdAt-index",
                "KeySchema": [
                    {"AttributeName": "userId", "KeyType": "HASH"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            },
        ],
        BillingMode="PAY_PER_REQUEST",
    )


def make_ops_table(dynamodb):
    return dynamodb.create_table(
        TableName="test-ops-recommendations",
        KeySchema=[
            {"AttributeName": "recommendationId", "KeyType": "HASH"},
            {"AttributeName": "timestamp", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "recommendationId", "AttributeType": "S"},
            {"AttributeName": "timestamp", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def past_iso(minutes: int = 30) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()


# ---- Tests: analyze_latency ----

@mock_aws
def test_analyze_latency_no_spike():
    dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
    make_image_table(dynamodb)
    table = dynamodb.Table("test-image-metadata")

    # Insert 10 PROCESSED images with latency well below threshold (3000ms)
    for i in range(10):
        table.put_item(Item={
            "imageId": str(uuid.uuid4()),
            "status": "PROCESSED",
            "processingLatencyMs": 1500 + i * 50,
            "updatedAt": now_iso(),
        })

    since = datetime.now(timezone.utc) - timedelta(hours=1)
    recs = analyze_latency(since)
    assert recs == [], f"Expected no recommendations but got: {recs}"


@mock_aws
def test_analyze_latency_detects_spike():
    dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
    make_image_table(dynamodb)
    table = dynamodb.Table("test-image-metadata")

    # 20 images: mix of normal and high-latency to push p95 above 3000ms
    latencies = [1200] * 14 + [7000, 8000, 9000, 10000, 11000, 12000]
    for lat in latencies:
        table.put_item(Item={
            "imageId": str(uuid.uuid4()),
            "status": "PROCESSED",
            "processingLatencyMs": lat,
            "updatedAt": now_iso(),
        })

    since = datetime.now(timezone.utc) - timedelta(hours=1)
    recs = analyze_latency(since)

    assert len(recs) == 1
    assert recs[0]["category"] == "LATENCY_SPIKE"
    assert recs[0]["severity"] == "HIGH"
    assert "p95Ms" in recs[0]["metrics"]
    assert recs[0]["metrics"]["p95Ms"] > 3000


@mock_aws
def test_analyze_latency_empty_table():
    dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
    make_image_table(dynamodb)
    since = datetime.now(timezone.utc) - timedelta(hours=1)
    recs = analyze_latency(since)
    assert recs == []


# ---- Tests: analyze_failure_rate ----

@mock_aws
def test_analyze_failure_rate_below_threshold():
    dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
    make_image_table(dynamodb)
    table = dynamodb.Table("test-image-metadata")

    # 97 processed, 3 failed = 3% failure rate (below 5% threshold)
    for _ in range(97):
        table.put_item(Item={"imageId": str(uuid.uuid4()), "status": "PROCESSED", "updatedAt": now_iso()})
    for _ in range(3):
        table.put_item(Item={"imageId": str(uuid.uuid4()), "status": "FAILED", "errorType": "REKOGNITION_ERROR", "updatedAt": now_iso()})

    since = datetime.now(timezone.utc) - timedelta(hours=1)
    recs = analyze_failure_rate(since)
    assert recs == []


@mock_aws
def test_analyze_failure_rate_above_threshold():
    dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
    make_image_table(dynamodb)
    table = dynamodb.Table("test-image-metadata")

    # 80 processed, 20 failed = 20% failure rate (above 5% threshold)
    for _ in range(80):
        table.put_item(Item={"imageId": str(uuid.uuid4()), "status": "PROCESSED", "updatedAt": now_iso()})
    for _ in range(20):
        table.put_item(Item={
            "imageId": str(uuid.uuid4()),
            "status": "FAILED",
            "errorType": "REKOGNITION_ERROR",
            "updatedAt": now_iso(),
        })

    since = datetime.now(timezone.utc) - timedelta(hours=1)
    recs = analyze_failure_rate(since)

    assert len(recs) == 1
    assert recs[0]["category"] == "HIGH_FAILURE_RATE"
    assert recs[0]["severity"] == "HIGH"
    assert recs[0]["metrics"]["failureRate"] == pytest.approx(0.2, abs=0.01)
    assert recs[0]["metrics"]["dominantError"] == "REKOGNITION_ERROR"


@mock_aws
def test_analyze_failure_rate_zero_images():
    dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
    make_image_table(dynamodb)
    since = datetime.now(timezone.utc) - timedelta(hours=1)
    recs = analyze_failure_rate(since)
    assert recs == []


# ---- Tests: analyze_duplicate_rate ----

@mock_aws
def test_analyze_duplicate_rate_below_threshold():
    dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
    make_image_table(dynamodb)
    table = dynamodb.Table("test-image-metadata")

    for _ in range(90):
        table.put_item(Item={"imageId": str(uuid.uuid4()), "status": "PROCESSED", "updatedAt": now_iso()})
    for _ in range(10):
        table.put_item(Item={"imageId": str(uuid.uuid4()), "status": "DUPLICATE", "updatedAt": now_iso()})

    since = datetime.now(timezone.utc) - timedelta(hours=1)
    recs = analyze_duplicate_rate(since)
    # 10% < 20% threshold
    assert recs == []


@mock_aws
def test_analyze_duplicate_rate_above_threshold():
    dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
    make_image_table(dynamodb)
    table = dynamodb.Table("test-image-metadata")

    for _ in range(60):
        table.put_item(Item={"imageId": str(uuid.uuid4()), "status": "PROCESSED", "updatedAt": now_iso()})
    for _ in range(40):
        table.put_item(Item={"imageId": str(uuid.uuid4()), "status": "DUPLICATE", "updatedAt": now_iso()})

    since = datetime.now(timezone.utc) - timedelta(hours=1)
    recs = analyze_duplicate_rate(since)

    assert len(recs) == 1
    assert recs[0]["category"] == "DUPLICATE_SURGE"
    assert recs[0]["severity"] == "MEDIUM"
    assert recs[0]["metrics"]["duplicateRate"] == pytest.approx(0.4, abs=0.01)
    assert recs[0]["metrics"]["savedCostUsd"] == pytest.approx(40 * 0.001, abs=0.0001)


# ---- Tests: analyze_low_confidence ----

@mock_aws
def test_analyze_low_confidence_all_high():
    dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
    make_image_table(dynamodb)
    table = dynamodb.Table("test-image-metadata")

    for _ in range(20):
        table.put_item(Item={
            "imageId": str(uuid.uuid4()),
            "status": "PROCESSED",
            "confidenceScore": 92,
            "updatedAt": now_iso(),
        })

    since = datetime.now(timezone.utc) - timedelta(hours=1)
    recs = analyze_low_confidence(since)
    assert recs == []


@mock_aws
def test_analyze_low_confidence_many_below_threshold():
    dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
    make_image_table(dynamodb)
    table = dynamodb.Table("test-image-metadata")

    for _ in range(10):
        table.put_item(Item={
            "imageId": str(uuid.uuid4()),
            "status": "PROCESSED",
            "confidenceScore": 60,  # Below 75 threshold
            "updatedAt": now_iso(),
        })

    since = datetime.now(timezone.utc) - timedelta(hours=1)
    recs = analyze_low_confidence(since)

    assert len(recs) == 1
    assert recs[0]["category"] == "LOW_CONFIDENCE_LABELS"
    assert recs[0]["metrics"]["lowConfidenceCount"] == 10
    assert recs[0]["metrics"]["avgConfidence"] == pytest.approx(60.0, abs=0.1)


# ---- Tests: analyze_hot_partitions ----

@mock_aws
def test_analyze_hot_partitions_no_skew():
    dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
    make_image_table(dynamodb)
    table = dynamodb.Table("test-image-metadata")

    # 10 different users, evenly distributed
    for i in range(20):
        table.put_item(Item={
            "imageId": str(uuid.uuid4()),
            "status": "PROCESSED",
            "userId": f"user-{i % 10}",
            "updatedAt": now_iso(),
        })

    since = datetime.now(timezone.utc) - timedelta(hours=1)
    recs = analyze_hot_partitions(since)
    assert recs == []


@mock_aws
def test_analyze_hot_partitions_detects_hot_user():
    dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
    make_image_table(dynamodb)
    table = dynamodb.Table("test-image-metadata")

    # One user writes 18 out of 20 items — 90% concentration
    for _ in range(18):
        table.put_item(Item={
            "imageId": str(uuid.uuid4()),
            "status": "PROCESSED",
            "userId": "hot-user",
            "updatedAt": now_iso(),
        })
    for _ in range(2):
        table.put_item(Item={
            "imageId": str(uuid.uuid4()),
            "status": "PROCESSED",
            "userId": "other-user",
            "updatedAt": now_iso(),
        })

    since = datetime.now(timezone.utc) - timedelta(hours=1)
    recs = analyze_hot_partitions(since)

    assert len(recs) == 1
    assert recs[0]["category"] == "HOT_PARTITION_RISK"
    assert recs[0]["metrics"]["hotUser"] == "hot-user"
    assert recs[0]["metrics"]["fraction"] > 0.5


# ---- Tests: write_recommendations ----

@mock_aws
def test_write_recommendations_persists_to_dynamodb():
    dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
    make_ops_table(dynamodb)

    recs = [
        {
            "category": "LATENCY_SPIKE",
            "severity": "HIGH",
            "sourceMetric": "p95_latency=7000ms",
            "description": "P95 is too high",
            "recommendedAction": "Increase Lambda memory",
            "confidence": 0.90,
            "metrics": {"p95Ms": 7000},
        }
    ]

    now = datetime.now(timezone.utc)
    write_recommendations(recs, now)

    table = dynamodb.Table("test-ops-recommendations")
    result = table.scan()
    items = result["Items"]

    assert len(items) == 1
    assert items[0]["category"] == "LATENCY_SPIKE"
    assert items[0]["severity"] == "HIGH"
    assert items[0]["status"] == "OPEN"
    assert "ttl" in items[0]
    assert int(items[0]["ttl"]) > now.timestamp()


@mock_aws
def test_write_recommendations_empty_list():
    dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
    make_ops_table(dynamodb)

    write_recommendations([], datetime.now(timezone.utc))

    table = dynamodb.Table("test-ops-recommendations")
    result = table.scan()
    assert result["Count"] == 0
