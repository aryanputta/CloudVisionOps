import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface MonitoringStackProps extends cdk.StackProps {
  stage: string;
  processorFunction: lambda.Function;
  uploadHandlerFunction: lambda.Function;
  opsAgentFunction: lambda.Function;
  dlq: sqs.Queue;
  alertTopic: sns.Topic;
  imageMetadataTable: dynamodb.Table;
}

export class MonitoringStack extends cdk.Stack {
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const { stage, processorFunction, uploadHandlerFunction, opsAgentFunction, dlq, alertTopic, imageMetadataTable } = props;

    const alarmAction = new cloudwatchActions.SnsAction(alertTopic);

    // ---- ALARMS ----

    // DLQ backlog alarm: fires when > 50 messages are sitting in the DLQ
    const dlqAlarm = new cloudwatch.Alarm(this, 'DLQDepthAlarm', {
      alarmName: `CloudVisionOps-DLQDepth-${stage}`,
      alarmDescription: 'DLQ depth exceeded 50 — processing failures need attention',
      metric: dlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 50,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlqAlarm.addAlarmAction(alarmAction);

    // Processor error rate alarm
    const processorErrorAlarm = new cloudwatch.Alarm(this, 'ProcessorErrorRateAlarm', {
      alarmName: `CloudVisionOps-ProcessorErrorRate-${stage}`,
      alarmDescription: 'Rekognition processor error rate above 5%',
      metric: processorFunction.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 10,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    processorErrorAlarm.addAlarmAction(alarmAction);

    // Cold start detection via duration spike (cold starts add ~1-3s vs warm)
    const processorDurationAlarm = new cloudwatch.Alarm(this, 'ProcessorDurationAlarm', {
      alarmName: `CloudVisionOps-ProcessorDuration-${stage}`,
      alarmDescription: 'Processor P95 duration above 5 seconds — likely cold starts or Rekognition latency',
      metric: processorFunction.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: 'p95',
      }),
      threshold: 5000,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    processorDurationAlarm.addAlarmAction(alarmAction);

    // Throttle alarm
    const throttleAlarm = new cloudwatch.Alarm(this, 'ProcessorThrottleAlarm', {
      alarmName: `CloudVisionOps-ProcessorThrottles-${stage}`,
      alarmDescription: 'Lambda concurrency limit hit — requests being throttled',
      metric: processorFunction.metricThrottles({
        period: cdk.Duration.minutes(1),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    throttleAlarm.addAlarmAction(alarmAction);

    // DynamoDB write throttle alarm
    const dynamoWriteThrottle = new cloudwatch.Alarm(this, 'DynamoWriteThrottleAlarm', {
      alarmName: `CloudVisionOps-DynamoWriteThrottle-${stage}`,
      alarmDescription: 'DynamoDB write throttles detected',
      metric: imageMetadataTable.metricThrottledRequestsForOperations({
        operations: [dynamodb.Operation.PUT_ITEM, dynamodb.Operation.UPDATE_ITEM],
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dynamoWriteThrottle.addAlarmAction(alarmAction);

    // ---- CUSTOM METRICS LOG GROUPS (structured CloudWatch EMF) ----

    new logs.MetricFilter(this, 'DuplicateDetectionMetric', {
      logGroup: logs.LogGroup.fromLogGroupName(
        this,
        'ProcessorLogGroup',
        `/aws/lambda/CloudVisionOps-RekognitionProcessor-${stage}`
      ),
      metricNamespace: 'CloudVisionOps',
      metricName: 'DuplicateDetected',
      filterPattern: logs.FilterPattern.exists('$.duplicate'),
      metricValue: '1',
      defaultValue: 0,
    });

    new logs.MetricFilter(this, 'ColdStartMetric', {
      logGroup: logs.LogGroup.fromLogGroupName(
        this,
        'ProcessorLogGroupCold',
        `/aws/lambda/CloudVisionOps-RekognitionProcessor-${stage}`
      ),
      metricNamespace: 'CloudVisionOps',
      metricName: 'ColdStart',
      filterPattern: logs.FilterPattern.exists('$.coldStart'),
      metricValue: '1',
      defaultValue: 0,
    });

    // ---- DASHBOARD ----

    this.dashboard = new cloudwatch.Dashboard(this, 'OperationsDashboard', {
      dashboardName: `CloudVisionOps-Operations-${stage}`,
      defaultInterval: cdk.Duration.hours(3),
    });

    this.dashboard.addWidgets(
      new cloudwatch.Row(
        new cloudwatch.TextWidget({
          markdown: `# CloudVisionOps — ${stage.toUpperCase()} Operations Dashboard`,
          width: 24,
          height: 1,
        })
      ),
      new cloudwatch.Row(
        new cloudwatch.GraphWidget({
          title: 'Processor Invocations vs Errors',
          width: 8,
          left: [
            processorFunction.metricInvocations({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
            processorFunction.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: 'Processor Duration (p50 / p95 / p99)',
          width: 8,
          left: [
            processorFunction.metricDuration({ period: cdk.Duration.minutes(5), statistic: 'p50', label: 'p50' }),
            processorFunction.metricDuration({ period: cdk.Duration.minutes(5), statistic: 'p95', label: 'p95' }),
            processorFunction.metricDuration({ period: cdk.Duration.minutes(5), statistic: 'p99', label: 'p99' }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: 'DLQ Depth',
          width: 8,
          left: [
            dlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1), statistic: 'Maximum' }),
          ],
        })
      ),
      new cloudwatch.Row(
        new cloudwatch.GraphWidget({
          title: 'DynamoDB Read/Write Capacity',
          width: 8,
          left: [
            imageMetadataTable.metricConsumedReadCapacityUnits({ period: cdk.Duration.minutes(5) }),
            imageMetadataTable.metricConsumedWriteCapacityUnits({ period: cdk.Duration.minutes(5) }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: 'Lambda Throttles',
          width: 8,
          left: [
            processorFunction.metricThrottles({ period: cdk.Duration.minutes(1), statistic: 'Sum' }),
            uploadHandlerFunction.metricThrottles({ period: cdk.Duration.minutes(1), statistic: 'Sum' }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: 'Cold Starts',
          width: 8,
          left: [
            new cloudwatch.Metric({
              namespace: 'CloudVisionOps',
              metricName: 'ColdStart',
              period: cdk.Duration.minutes(5),
              statistic: 'Sum',
            }),
          ],
        })
      ),
      new cloudwatch.Row(
        new cloudwatch.AlarmStatusWidget({
          title: 'Alarm Status',
          alarms: [dlqAlarm, processorErrorAlarm, processorDurationAlarm, throttleAlarm, dynamoWriteThrottle],
          width: 24,
          height: 3,
        })
      )
    );

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${this.dashboard.dashboardName}`,
      exportName: `${id}-DashboardUrl`,
    });
  }
}
