"""
SSM Parameter Store integration for the Ops Agent.

Amazon pattern: never bake config into environment variables for values that
change at runtime (thresholds, feature flags, model versions). Use SSM Parameter
Store so ops can update thresholds without a Lambda redeploy.

SecureString parameters are encrypted with KMS and never appear in logs.
"""

import os
import logging
from typing import Optional

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

ssm = boto3.client("ssm", region_name=os.environ.get("AWS_REGION", "us-east-1"))

STAGE = os.environ.get("STAGE", "dev")
PREFIX = f"/CloudVisionOps/{STAGE}"

# Cache parameters for the Lambda warm invocation window
_cache: dict[str, str] = {}


def get_parameter(name: str, default: Optional[str] = None, use_cache: bool = True) -> Optional[str]:
    """
    Fetches a parameter from SSM Parameter Store.
    Falls back to environment variable, then to default.
    """
    full_name = f"{PREFIX}/{name}"

    if use_cache and full_name in _cache:
        return _cache[full_name]

    # First check environment variable override (for local dev / CI)
    env_override = os.environ.get(name.upper().replace("-", "_").replace("/", "_"))
    if env_override:
        return env_override

    try:
        response = ssm.get_parameter(Name=full_name, WithDecryption=True)
        value = response["Parameter"]["Value"]
        _cache[full_name] = value
        return value
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code == "ParameterNotFound":
            logger.debug(f"SSM parameter {full_name} not found, using default")
            return default
        logger.warning(f"SSM get_parameter failed for {full_name}: {e}")
        return default


def get_float(name: str, default: float) -> float:
    value = get_parameter(name, str(default))
    try:
        return float(value)  # type: ignore
    except (TypeError, ValueError):
        return default


def get_int(name: str, default: int) -> int:
    value = get_parameter(name, str(default))
    try:
        return int(value)  # type: ignore
    except (TypeError, ValueError):
        return default


def get_bool(name: str, default: bool) -> bool:
    value = get_parameter(name, str(default).lower())
    return str(value).lower() in ("true", "1", "yes")


# Named parameter accessors — these map to SSM paths like /CloudVisionOps/dev/latency-spike-threshold-ms

def latency_spike_threshold_ms() -> float:
    return get_float("latency-spike-threshold-ms", 5000.0)


def high_failure_rate_threshold() -> float:
    return get_float("high-failure-rate-threshold", 0.05)


def dlq_backlog_threshold() -> int:
    return get_int("dlq-backlog-threshold", 50)


def duplicate_surge_threshold() -> float:
    return get_float("duplicate-surge-threshold", 0.30)


def low_confidence_threshold() -> float:
    return get_float("low-confidence-threshold", 75.0)


def ops_agent_enabled() -> bool:
    return get_bool("ops-agent-enabled", True)
