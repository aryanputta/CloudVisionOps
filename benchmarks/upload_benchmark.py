#!/usr/bin/env python3
"""
CloudVisionOps Benchmark Script

Uploads batches of images through the pipeline and records latency,
throughput, failure rates, duplicate detection, and cost estimates.

Usage:
  python3 benchmarks/upload_benchmark.py --batch 100 --workers 10
  python3 benchmarks/upload_benchmark.py --batch 1000 --workers 20 --include-duplicates
  python3 benchmarks/upload_benchmark.py --dry-run
"""

import argparse
import csv
import io
import json
import os
import random
import statistics
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import boto3
import requests

# ---- Config ----

API_BASE_URL = os.environ.get("API_BASE_URL", "")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
IMAGE_TABLE = os.environ.get("IMAGE_METADATA_TABLE", "")

# AWS pricing constants (us-east-1, 2024)
REKOGNITION_PRICE_PER_IMAGE = 0.001        # $0.001 per image analyzed
LAMBDA_PRICE_PER_GB_SECOND = 0.0000166667 # $0.0000166667 per GB-second
LAMBDA_PRICE_PER_REQUEST = 0.0000002      # $0.0000002 per request
DYNAMODB_WRITE_PRICE_PER_WCU = 0.00000125 # per WCU (on-demand)
DYNAMODB_READ_PRICE_PER_RCU = 0.00000025  # per RCU (on-demand)
S3_PUT_PRICE = 0.0000005                  # per PUT request

BENCHMARK_DIR = Path(__file__).parent

# ---- Data classes ----

@dataclass
class UploadResult:
    image_id: str
    round_trip_ms: float
    presign_ms: float
    s3_upload_ms: float
    processing_ms: float
    status: str
    dominant_label: str
    confidence_score: float
    label_count: int
    retry_count: int
    cold_start: bool
    duplicate_of: Optional[str]
    error_type: Optional[str]
    rekognition_calls: int
    dynamodb_writes: int
    estimated_cost_usd: float
    timestamp: str

@dataclass
class BenchmarkSummary:
    batch_size: int
    workers: int
    start_time: str
    end_time: str
    total_duration_s: float
    throughput_images_per_sec: float
    avg_latency_ms: float
    median_latency_ms: float
    p50_latency_ms: float
    p95_latency_ms: float
    p99_latency_ms: float
    min_latency_ms: float
    max_latency_ms: float
    success_count: int
    failure_count: int
    duplicate_count: int
    failure_rate: float
    duplicate_rate: float
    cold_start_count: int
    total_rekognition_calls: int
    total_cost_usd: float
    cost_per_1000_images_usd: float
    cost_savings_from_dedup_usd: float


# ---- Image generation ----

def generate_test_image(width: int = 200, height: int = 200) -> bytes:
    """Generate a valid JPEG image in memory without PIL dependency."""
    # Minimal valid JPEG (SOI + JFIF + EOI markers)
    # This is a 1x1 pixel white JPEG that Rekognition can process
    jpeg_bytes = (
        b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00'
        b'\xff\xdb\x00C\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07\x07\t\t'
        b'\x08\n\x0c\x14\r\x0c\x0b\x0b\x0c\x19\x12\x13\x0f\x14\x1d\x1a'
        b'\x1f\x1e\x1d\x1a\x1c\x1c $.\' ",#\x1c\x1c(7),01444\x1f\'9=82<.342\x1e\xbf'
        b'\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00'
        b'\xff\xc4\x00\x1f\x00\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00'
        b'\x00\x00\x00\x00\x00\x00\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b'
        b'\xff\xc4\x00\xb5\x10\x00\x02\x01\x03\x03\x02\x04\x03\x05\x05\x04'
        b'\x04\x00\x00\x01}\x01\x02\x03\x00\x04\x11\x05\x12!1A\x06\x13Qa'
        b'\x07"q\x142\x81\x91\xa1\x08#B\xb1\xc1\x15R\xd1\xf0$3br'
        b'\x82\t\n\x16\x17\x18\x19\x1a%&\'()*456789:CDEFGHIJ'
        b'STUVWXYZ\xff\xda\x00\x08\x01\x01\x00\x00?\x00\xf5\x0f\xff\xd9'
    )
    return jpeg_bytes


# ---- API calls ----

def get_presigned_url(session: requests.Session, file_size: int) -> tuple[str, str, float]:
    """Returns (imageId, uploadUrl, elapsed_ms)."""
    start = time.perf_counter()
    resp = session.post(
        f"{API_BASE_URL}/uploads/presign",
        json={
            "fileName": f"benchmark-{uuid.uuid4()}.jpg",
            "contentType": "image/jpeg",
            "fileSize": file_size,
            "userId": "benchmark-user",
        },
        timeout=15,
    )
    elapsed_ms = (time.perf_counter() - start) * 1000
    resp.raise_for_status()
    data = resp.json()
    return data["imageId"], data["uploadUrl"], elapsed_ms


def upload_to_s3(session: requests.Session, url: str, image_bytes: bytes) -> float:
    """Uploads image to S3 pre-signed URL. Returns elapsed ms."""
    start = time.perf_counter()
    resp = session.put(
        url,
        data=image_bytes,
        headers={"Content-Type": "image/jpeg"},
        timeout=30,
    )
    elapsed_ms = (time.perf_counter() - start) * 1000
    resp.raise_for_status()
    return elapsed_ms


def poll_for_result(image_id: str, timeout_s: int = 60) -> dict:
    """Polls DynamoDB directly for image processing result."""
    dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
    table = dynamodb.Table(IMAGE_TABLE)

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        resp = table.get_item(Key={"imageId": image_id})
        item = resp.get("Item")
        if item and item.get("status") not in ("PENDING", "PROCESSING"):
            return item
        time.sleep(1)

    return {"status": "TIMEOUT", "imageId": image_id}


def estimate_cost(status: str, processing_ms: float, rekognition_calls: int) -> float:
    """Estimate the total AWS cost for processing one image."""
    cost = 0.0

    # S3 PUT request
    cost += S3_PUT_PRICE

    # Lambda: processor (1024 MB, ~processing_ms duration)
    lambda_duration_s = max(processing_ms / 1000, 0.001)
    lambda_gb_seconds = (1024 / 1024) * lambda_duration_s
    cost += lambda_gb_seconds * LAMBDA_PRICE_PER_GB_SECOND
    cost += LAMBDA_PRICE_PER_REQUEST

    # Rekognition
    cost += rekognition_calls * REKOGNITION_PRICE_PER_IMAGE

    # DynamoDB writes (approximate: 2 writes per image — PENDING + result)
    cost += 2 * DYNAMODB_WRITE_PRICE_PER_WCU

    return cost


# ---- Core benchmark function ----

def benchmark_single(image_bytes: bytes, is_duplicate: bool = False) -> UploadResult:
    session = requests.Session()
    session.headers.update({"X-Benchmark": "true"})

    overall_start = time.perf_counter()
    timestamp = datetime.now(timezone.utc).isoformat()

    try:
        image_id, upload_url, presign_ms = get_presigned_url(session, len(image_bytes))
        s3_ms = upload_to_s3(session, upload_url, image_bytes)

        processing_start = time.perf_counter()
        result = poll_for_result(image_id)
        processing_ms = (time.perf_counter() - processing_start) * 1000

        round_trip_ms = (time.perf_counter() - overall_start) * 1000
        status = result.get("status", "UNKNOWN")
        is_dup = status == "DUPLICATE"
        rekognition_calls = 0 if is_dup else 1

        return UploadResult(
            image_id=image_id,
            round_trip_ms=round(round_trip_ms, 2),
            presign_ms=round(presign_ms, 2),
            s3_upload_ms=round(s3_ms, 2),
            processing_ms=round(processing_ms, 2),
            status=status,
            dominant_label=result.get("dominantLabel", ""),
            confidence_score=float(result.get("confidenceScore", 0)),
            label_count=len(result.get("labels", [])),
            retry_count=int(result.get("retryCount", 0)),
            cold_start=bool(result.get("coldStart", False)),
            duplicate_of=result.get("duplicateOf"),
            error_type=result.get("errorType"),
            rekognition_calls=rekognition_calls,
            dynamodb_writes=2,
            estimated_cost_usd=estimate_cost(status, processing_ms, rekognition_calls),
            timestamp=timestamp,
        )
    except Exception as e:
        return UploadResult(
            image_id="error",
            round_trip_ms=(time.perf_counter() - overall_start) * 1000,
            presign_ms=0,
            s3_upload_ms=0,
            processing_ms=0,
            status="CLIENT_ERROR",
            dominant_label="",
            confidence_score=0,
            label_count=0,
            retry_count=0,
            cold_start=False,
            duplicate_of=None,
            error_type=type(e).__name__,
            rekognition_calls=0,
            dynamodb_writes=0,
            estimated_cost_usd=0,
            timestamp=timestamp,
        )


# ---- Main benchmark runner ----

def run_benchmark(batch_size: int, workers: int, include_duplicates: bool, dry_run: bool) -> None:
    print(f"\nCloudVisionOps Benchmark")
    print(f"{'=' * 50}")
    print(f"Batch size : {batch_size}")
    print(f"Workers    : {workers}")
    print(f"Duplicates : {include_duplicates}")
    print(f"Dry run    : {dry_run}")
    print(f"API URL    : {API_BASE_URL}")
    print(f"{'=' * 50}\n")

    if dry_run:
        print("[DRY RUN] Would upload", batch_size, "images. Exiting.")
        return

    if not API_BASE_URL:
        print("ERROR: API_BASE_URL environment variable not set. Deploy the stack first.")
        sys.exit(1)

    # Pre-generate test images
    base_image = generate_test_image()
    images = []
    for i in range(batch_size):
        # Every 10th image is a duplicate if enabled
        if include_duplicates and i > 0 and i % 10 == 0:
            images.append((base_image, True))
        else:
            # Vary image slightly to avoid all being duplicates
            variant = base_image[:-4] + random.randbytes(4)
            images.append((variant, False))

    start_time = datetime.now(timezone.utc)
    start_ts = time.perf_counter()

    results: list[UploadResult] = []
    completed = 0

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(benchmark_single, img, is_dup): i for i, (img, is_dup) in enumerate(images)}

        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            completed += 1
            if completed % 10 == 0 or completed == batch_size:
                print(f"  Progress: {completed}/{batch_size} | last: {result.status} {result.round_trip_ms:.0f}ms")

    total_s = time.perf_counter() - start_ts
    end_time = datetime.now(timezone.utc)

    # ---- Compute summary stats ----

    latencies = [r.round_trip_ms for r in results if r.status not in ("CLIENT_ERROR", "TIMEOUT")]
    if not latencies:
        print("ERROR: All requests failed. Check API_BASE_URL and deployment.")
        sys.exit(1)

    sorted_lat = sorted(latencies)
    n = len(sorted_lat)

    def percentile(lst, p):
        idx = max(0, int(len(lst) * p / 100) - 1)
        return lst[idx]

    successes = [r for r in results if r.status == "PROCESSED"]
    failures = [r for r in results if r.status in ("FAILED", "CLIENT_ERROR", "TIMEOUT")]
    duplicates = [r for r in results if r.status == "DUPLICATE"]
    cold_starts = [r for r in results if r.cold_start]

    total_cost = sum(r.estimated_cost_usd for r in results)
    dedup_savings = len(duplicates) * REKOGNITION_PRICE_PER_IMAGE

    summary = BenchmarkSummary(
        batch_size=batch_size,
        workers=workers,
        start_time=start_time.isoformat(),
        end_time=end_time.isoformat(),
        total_duration_s=round(total_s, 2),
        throughput_images_per_sec=round(batch_size / total_s, 2),
        avg_latency_ms=round(statistics.mean(latencies), 2),
        median_latency_ms=round(statistics.median(latencies), 2),
        p50_latency_ms=round(percentile(sorted_lat, 50), 2),
        p95_latency_ms=round(percentile(sorted_lat, 95), 2),
        p99_latency_ms=round(percentile(sorted_lat, 99), 2),
        min_latency_ms=round(min(latencies), 2),
        max_latency_ms=round(max(latencies), 2),
        success_count=len(successes),
        failure_count=len(failures),
        duplicate_count=len(duplicates),
        failure_rate=round(len(failures) / batch_size, 4),
        duplicate_rate=round(len(duplicates) / batch_size, 4),
        cold_start_count=len(cold_starts),
        total_rekognition_calls=sum(r.rekognition_calls for r in results),
        total_cost_usd=round(total_cost, 6),
        cost_per_1000_images_usd=round((total_cost / batch_size) * 1000, 4),
        cost_savings_from_dedup_usd=round(dedup_savings, 6),
    )

    # ---- Print summary ----

    print(f"\n{'=' * 50}")
    print(f"BENCHMARK RESULTS")
    print(f"{'=' * 50}")
    print(f"Duration        : {summary.total_duration_s}s")
    print(f"Throughput      : {summary.throughput_images_per_sec} img/s")
    print(f"Success         : {summary.success_count}/{batch_size} ({(1-summary.failure_rate)*100:.1f}%)")
    print(f"Failures        : {summary.failure_count} ({summary.failure_rate*100:.2f}%)")
    print(f"Duplicates      : {summary.duplicate_count} ({summary.duplicate_rate*100:.1f}%)")
    print(f"Cold starts     : {summary.cold_start_count}")
    print(f"\nLatency:")
    print(f"  avg           : {summary.avg_latency_ms}ms")
    print(f"  p50           : {summary.p50_latency_ms}ms")
    print(f"  p95           : {summary.p95_latency_ms}ms")
    print(f"  p99           : {summary.p99_latency_ms}ms")
    print(f"  min           : {summary.min_latency_ms}ms")
    print(f"  max           : {summary.max_latency_ms}ms")
    print(f"\nCost:")
    print(f"  Total         : ${summary.total_cost_usd:.6f}")
    print(f"  Per 1000 imgs : ${summary.cost_per_1000_images_usd:.4f}")
    print(f"  Dedup savings : ${summary.cost_savings_from_dedup_usd:.6f}")
    print(f"{'=' * 50}\n")

    # ---- Write CSVs ----

    write_latency_csv(results, summary)
    write_cost_csv(results, summary)
    write_failure_csv([r for r in results if r.status not in ("PROCESSED", "DUPLICATE")])
    write_duplicate_csv([r for r in results if r.status == "DUPLICATE"])

    # Write summary JSON
    summary_path = BENCHMARK_DIR / "benchmark_summary.json"
    with open(summary_path, "w") as f:
        json.dump(asdict(summary), f, indent=2)

    print(f"Results written to benchmarks/")


def write_latency_csv(results: list[UploadResult], summary: BenchmarkSummary) -> None:
    path = BENCHMARK_DIR / "latency_results.csv"
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "image_id", "status", "round_trip_ms", "presign_ms", "s3_upload_ms",
            "processing_ms", "dominant_label", "confidence_score", "label_count",
            "cold_start", "retry_count", "timestamp"
        ])
        for r in results:
            writer.writerow([
                r.image_id, r.status, r.round_trip_ms, r.presign_ms, r.s3_upload_ms,
                r.processing_ms, r.dominant_label, r.confidence_score, r.label_count,
                r.cold_start, r.retry_count, r.timestamp
            ])

        # Summary row
        writer.writerow([])
        writer.writerow(["# SUMMARY"])
        writer.writerow(["batch_size", summary.batch_size])
        writer.writerow(["avg_ms", summary.avg_latency_ms])
        writer.writerow(["p50_ms", summary.p50_latency_ms])
        writer.writerow(["p95_ms", summary.p95_latency_ms])
        writer.writerow(["p99_ms", summary.p99_latency_ms])
        writer.writerow(["throughput_img_per_sec", summary.throughput_images_per_sec])

    print(f"  Latency results → {path}")


def write_cost_csv(results: list[UploadResult], summary: BenchmarkSummary) -> None:
    path = BENCHMARK_DIR / "cost_results.csv"
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["image_id", "status", "rekognition_calls", "dynamodb_writes", "estimated_cost_usd"])
        for r in results:
            writer.writerow([r.image_id, r.status, r.rekognition_calls, r.dynamodb_writes, r.estimated_cost_usd])

        writer.writerow([])
        writer.writerow(["# COST SUMMARY"])
        writer.writerow(["total_usd", summary.total_cost_usd])
        writer.writerow(["per_1000_images_usd", summary.cost_per_1000_images_usd])
        writer.writerow(["dedup_savings_usd", summary.cost_savings_from_dedup_usd])

    print(f"  Cost results    → {path}")


def write_failure_csv(failures: list[UploadResult]) -> None:
    path = BENCHMARK_DIR / "failure_results.csv"
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["image_id", "status", "error_type", "retry_count", "round_trip_ms", "timestamp"])
        for r in failures:
            writer.writerow([r.image_id, r.status, r.error_type, r.retry_count, r.round_trip_ms, r.timestamp])

    print(f"  Failure results → {path}")


def write_duplicate_csv(duplicates: list[UploadResult]) -> None:
    path = BENCHMARK_DIR / "duplicate_detection_results.csv"
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["image_id", "duplicate_of", "round_trip_ms", "rekognition_saved", "cost_saved_usd", "timestamp"])
        for r in duplicates:
            writer.writerow([r.image_id, r.duplicate_of, r.round_trip_ms, 1, REKOGNITION_PRICE_PER_IMAGE, r.timestamp])

    print(f"  Duplicate results → {path}")


def run_simulation(batch_size: int, include_duplicates: bool, seed: int = 1337) -> None:
    """Local simulation: no AWS required.

    The duplicate-detection result is real: images are deduplicated by SHA-256
    content hash, the same strategy the pipeline uses (see calculateImageHash in
    backend/shared/utils.ts), and Rekognition is skipped for duplicates. Latency
    is a documented model, not a live network measurement, so a recruiter can run
    the benchmark and verify the dedup + cost logic without deploying the stack.
    """
    import hashlib

    rng = random.Random(seed)
    labels = ["Person", "Car", "Dog", "Building", "Tree", "Food", "Text", "Phone"]
    seen_hashes: dict[str, str] = {}
    results: list[UploadResult] = []
    start = time.time()

    for i in range(batch_size):
        # Every 10th image (when enabled) is an exact duplicate of the prior
        # unique image, so it deduplicates by content hash.
        if include_duplicates and i >= 10 and i % 10 == 0:
            content = f"image-{i - 1}".encode()
        else:
            content = f"image-{i}".encode()
        digest = hashlib.sha256(content).hexdigest()

        cold = i < 3  # first few requests pay cold-start cost
        presign = rng.uniform(8, 20)
        s3_upload = rng.uniform(20, 60)

        if digest in seen_hashes:
            # Duplicate: detected by content hash, Rekognition skipped.
            rt = presign + s3_upload + rng.uniform(2, 6)
            results.append(UploadResult(
                image_id=str(uuid.uuid4()), round_trip_ms=round(rt, 2), presign_ms=round(presign, 2),
                s3_upload_ms=round(s3_upload, 2), processing_ms=0.0, status="DUPLICATE",
                dominant_label="", confidence_score=0.0, label_count=0, retry_count=0, cold_start=cold,
                duplicate_of=seen_hashes[digest], error_type=None, rekognition_calls=0, dynamodb_writes=0,
                estimated_cost_usd=0.0, timestamp=datetime.now(timezone.utc).isoformat(),
            ))
            continue

        seen_hashes[digest] = digest[:12]
        processing = rng.uniform(120, 280) + (350 if cold else 0)
        rt = presign + s3_upload + processing
        cost = REKOGNITION_PRICE_PER_IMAGE + LAMBDA_PRICE_PER_REQUEST * 3 + DYNAMODB_WRITE_PRICE_PER_WCU + S3_PUT_PRICE
        results.append(UploadResult(
            image_id=str(uuid.uuid4()), round_trip_ms=round(rt, 2), presign_ms=round(presign, 2),
            s3_upload_ms=round(s3_upload, 2), processing_ms=round(processing, 2), status="SUCCESS",
            dominant_label=rng.choice(labels), confidence_score=round(rng.uniform(80, 99), 2),
            label_count=rng.randint(1, 6), retry_count=0, cold_start=cold, duplicate_of=None,
            error_type=None, rekognition_calls=1, dynamodb_writes=1,
            estimated_cost_usd=round(cost, 8), timestamp=datetime.now(timezone.utc).isoformat(),
        ))

    duration = time.time() - start
    lat = sorted(r.round_trip_ms for r in results)
    dups = [r for r in results if r.status == "DUPLICATE"]
    succ = [r for r in results if r.status == "SUCCESS"]
    pctl = lambda p: lat[min(len(lat) - 1, int(p / 100 * len(lat)))] if lat else 0.0
    total_cost = sum(r.estimated_cost_usd for r in results)
    summary = BenchmarkSummary(
        batch_size=batch_size, workers=1, start_time=datetime.now(timezone.utc).isoformat(),
        end_time=datetime.now(timezone.utc).isoformat(), total_duration_s=round(duration, 3),
        throughput_images_per_sec=round(batch_size / duration, 1) if duration else 0.0,
        avg_latency_ms=round(statistics.mean(lat), 2) if lat else 0.0,
        median_latency_ms=round(statistics.median(lat), 2) if lat else 0.0,
        p50_latency_ms=round(pctl(50), 2), p95_latency_ms=round(pctl(95), 2), p99_latency_ms=round(pctl(99), 2),
        min_latency_ms=round(lat[0], 2) if lat else 0.0, max_latency_ms=round(lat[-1], 2) if lat else 0.0,
        success_count=len(succ), failure_count=0, duplicate_count=len(dups),
        failure_rate=0.0, duplicate_rate=round(len(dups) / batch_size, 4) if batch_size else 0.0,
        cold_start_count=sum(1 for r in results if r.cold_start),
        total_rekognition_calls=sum(r.rekognition_calls for r in results),
        total_cost_usd=round(total_cost, 6),
        cost_per_1000_images_usd=round(total_cost / batch_size * 1000, 4) if batch_size else 0.0,
        cost_savings_from_dedup_usd=round(len(dups) * REKOGNITION_PRICE_PER_IMAGE, 6),
    )

    write_latency_csv(results, summary)
    write_cost_csv(results, summary)
    write_duplicate_csv(dups)

    print("CloudVisionOps Benchmark (local simulation, no AWS)")
    print("=" * 50)
    print(f"Images                 : {batch_size}")
    print(f"Duplicates detected    : {len(dups)} ({summary.duplicate_rate * 100:.1f}%) via SHA-256 content hash")
    print(f"Rekognition calls saved: {len(dups)}  (cost saved ${summary.cost_savings_from_dedup_usd})")
    print(f"Latency p50/p95/p99 ms : {summary.p50_latency_ms} / {summary.p95_latency_ms} / {summary.p99_latency_ms}")
    print(f"Est. cost / 1000 images: ${summary.cost_per_1000_images_usd}")
    print("Results written to benchmarks/*.csv")
    print("Note: dedup + cost are real logic; latency is a documented model, not a live measurement.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="CloudVisionOps benchmark script")
    parser.add_argument("--batch", type=int, default=10, help="Number of images to upload")
    parser.add_argument("--workers", type=int, default=5, help="Concurrent upload workers")
    parser.add_argument("--include-duplicates", action="store_true", help="Include duplicate uploads (every 10th)")
    parser.add_argument("--dry-run", action="store_true", help="Print config and exit without uploading")
    parser.add_argument("--simulate", action="store_true", help="Run locally without AWS (real dedup, modeled latency)")
    args = parser.parse_args()

    if args.simulate:
        run_simulation(args.batch, args.include_duplicates)
    else:
        run_benchmark(args.batch, args.workers, args.include_duplicates, args.dry_run)
