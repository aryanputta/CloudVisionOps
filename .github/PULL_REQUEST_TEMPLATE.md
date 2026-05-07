## What changed

<!-- One sentence. What does this PR do? -->

## Why

<!-- Root cause or motivation. Link to issue or COE if relevant. -->

## Metrics (required for any pipeline or infra change)

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| p95 latency (ms) | | | |
| Failure rate (%) | | | |
| Cold start rate | | | |
| DLQ depth | | | |

*Leave rows blank if not applicable. "N/A" is not acceptable for pipeline changes — measure it.*

## Test plan

- [ ] Unit tests pass locally (`npm test`)
- [ ] Python ops-agent tests pass (`pytest tests/unit/test_ops_agent.py -v`)
- [ ] CDK synth succeeds (`npx cdk synth --all`)
- [ ] Manually tested in dev environment
- [ ] Smoke test endpoint health: `GET /health` → 200

## Rollback plan

<!-- How do we undo this if it breaks prod? Specific steps — not "redeploy previous version". -->

1. 
2. 

## Checklist

- [ ] No secrets or credentials in code or environment variables committed
- [ ] DynamoDB changes: no breaking schema changes without migration plan
- [ ] Lambda memory/timeout changes: justified with benchmark data above
- [ ] New IAM permissions: least-privilege, scoped to specific resources
- [ ] Idempotent: Lambda can be invoked twice with the same input without side effects
- [ ] COE updated if this is a bug fix for a past incident (`docs/coe.md`)
- [ ] Runbook updated if alarm thresholds changed (`docs/runbook.md`)
- [ ] CHANGELOG updated with before/after numbers (`CHANGELOG.md`)
