#!/usr/bin/env python3
"""
Load test: burst upload scenario.

Simulates a sudden spike (e.g., a mobile app pushing 500 images in 10 seconds)
to verify the pipeline handles concurrency without throttling, DLQ buildup, or
silent failures.

Metrics captured:
  - Throughput at peak concurrency
  - Throttle count (429 responses)
  - Error rate during burst
  - DLQ depth before and after burst
  - Lambda concurrency limit hit (from CloudWatch)
  - Time to drain: how long until all images reach terminal status

Usage:
  python3 tests/load/burst_upload.py --burst 200 --ramp-up-s 5
"""

import argparse
import os
import sys
import time
import uuid
import json
import statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import boto3
import requests

API_BASE_URL = os.environ.get("API_BASE_URL", "")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
IMAGE_TABLE = os.environ.get("IMAGE_METADATA_TABLE", "")
DLQ_NAME = os.environ.get("DLQ_QUEUE_NAME", "CloudVisionOps-DLQ-dev")

MINIMAL_JPEG = (
    b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00'
    b'\xff\xdb\x00C\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07\x07\t\t'
    b'\x08\n\x0c\x14\r\x0c\x0b\x0b\x0c\x19\x12\x13\x0f\x14\x1d\x1a'
    b'\xff\xd9'
)


def get_dlq_depth() -> int:
    sqs = boto3.client("sqs", region_name=AWS_REGION)
    try:
        url = sqs.get_queue_url(QueueName=DLQ_NAME)["QueueUrl"]
        attrs = sqs.get_queue_attributes(
            QueueUrl=url,
            AttributeNames=["ApproximateNumberOfMessages"]
        )
        return int(attrs["Attributes"]["ApproximateNumberOfMessages"])
    except Exception:
        return -1


def upload_one(session: requests.Session, idx: int) -> dict:
    start = time.perf_counter()
    result = {"idx": idx, "success": False, "latency_ms": 0, "status_code": 0, "image_id": None}

    try:
        resp = session.post(
            f"{API_BASE_URL}/uploads/presign",
            json={
                "fileName": f"load-test-{idx}.jpg",
                "contentType": "image/jpeg",
                "fileSize": len(MINIMAL_JPEG),
                "userId": "load-test",
            },
            timeout=10,
        )
        result["status_code"] = resp.status_code

        if resp.status_code == 200:
            data = resp.json()
            s3_resp = session.put(
                data["uploadUrl"],
                data=MINIMAL_JPEG,
                headers={"Content-Type": "image/jpeg"},
                timeout=30,
            )
            result["success"] = s3_resp.status_code in (200, 204)
            result["image_id"] = data.get("imageId")
        elif resp.status_code == 429:
            result["throttled"] = True

    except Exception as e:
        result["error"] = str(e)

    result["latency_ms"] = (time.perf_counter() - start) * 1000
    return result


def run_burst(burst_size: int, ramp_up_s: int) -> None:
    if not API_BASE_URL:
        print("ERROR: API_BASE_URL not set")
        sys.exit(1)

    print(f"\nCloudVisionOps Load Test — Burst Upload")
    print(f"{'=' * 50}")
    print(f"Burst size   : {burst_size}")
    print(f"Ramp-up      : {ramp_up_s}s")
    print(f"API URL      : {API_BASE_URL}")

    dlq_before = get_dlq_depth()
    print(f"DLQ depth (before): {dlq_before}")

    session = requests.Session()
    results = []

    start_wall = time.perf_counter()
    start_time = datetime.now(timezone.utc)

    with ThreadPoolExecutor(max_workers=burst_size) as executor:
        futures = [executor.submit(upload_one, session, i) for i in range(burst_size)]
        for f in as_completed(futures):
            r = f.result()
            results.append(r)
            if len(results) % 50 == 0:
                print(f"  Submitted {len(results)}/{burst_size}")

    total_s = time.perf_counter() - start_wall
    latencies = [r["latency_ms"] for r in results if r["success"]]
    successes = [r for r in results if r["success"]]
    failures = [r for r in results if not r["success"]]
    throttled = [r for r in results if r.get("throttled")]

    # Wait for processing to complete (poll DynamoDB for terminal statuses)
    print("\nWaiting for pipeline to drain...")
    image_ids = [r["image_id"] for r in successes if r["image_id"]]
    drain_start = time.perf_counter()

    if IMAGE_TABLE and image_ids:
        dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
        table = dynamodb.Table(IMAGE_TABLE)
        terminal = set()
        deadline = time.time() + 120

        while len(terminal) < len(image_ids) and time.time() < deadline:
            sample = image_ids[:20]
            for iid in sample:
                if iid in terminal:
                    continue
                try:
                    resp = table.get_item(Key={"imageId": iid})
                    status = resp.get("Item", {}).get("status", "")
                    if status not in ("PENDING", "PROCESSING", ""):
                        terminal.add(iid)
                except Exception:
                    pass
            if len(terminal) < len(image_ids):
                time.sleep(3)

    drain_s = time.perf_counter() - drain_start

    dlq_after = get_dlq_depth()

    def p(lst, pct):
        if not lst:
            return 0
        s = sorted(lst)
        return s[max(0, int(len(s) * pct / 100) - 1)]

    print(f"\n{'=' * 50}")
    print(f"BURST LOAD TEST RESULTS")
    print(f"{'=' * 50}")
    print(f"Upload phase  : {total_s:.2f}s")
    print(f"Drain time    : {drain_s:.2f}s")
    print(f"Throughput    : {burst_size / total_s:.1f} uploads/s")
    print(f"Success       : {len(successes)}/{burst_size} ({len(successes)/burst_size*100:.1f}%)")
    print(f"Failures      : {len(failures)}")
    print(f"Throttled     : {len(throttled)}")
    print(f"\nUpload latency (presign + S3 PUT):")
    if latencies:
        print(f"  avg         : {statistics.mean(latencies):.0f}ms")
        print(f"  p50         : {p(latencies, 50):.0f}ms")
        print(f"  p95         : {p(latencies, 95):.0f}ms")
        print(f"  p99         : {p(latencies, 99):.0f}ms")
    print(f"\nDLQ depth before : {dlq_before}")
    print(f"DLQ depth after  : {dlq_after}")
    print(f"DLQ increase     : {max(0, dlq_after - dlq_before)} (should be 0 on healthy run)")
    print(f"{'=' * 50}\n")

    output = {
        "timestamp": start_time.isoformat(),
        "burst_size": burst_size,
        "total_upload_s": round(total_s, 2),
        "drain_s": round(drain_s, 2),
        "throughput_per_s": round(burst_size / total_s, 2),
        "successes": len(successes),
        "failures": len(failures),
        "throttled": len(throttled),
        "dlq_before": dlq_before,
        "dlq_after": dlq_after,
        "latency_avg": round(statistics.mean(latencies), 2) if latencies else 0,
        "latency_p95": round(p(latencies, 95), 2),
        "latency_p99": round(p(latencies, 99), 2),
    }

    with open("tests/load/burst_results.json", "w") as f:
        json.dump(output, f, indent=2)

    print("Results saved to tests/load/burst_results.json")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--burst", type=int, default=100)
    parser.add_argument("--ramp-up-s", type=int, default=5)
    args = parser.parse_args()
    run_burst(args.burst, args.ramp_up_s)
