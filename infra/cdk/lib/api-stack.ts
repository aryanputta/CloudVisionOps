import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface ApiStackProps extends cdk.StackProps {
  stage: string;
  uploadUrlHandler: lambda.Function;
  metadataQueryHandler: lambda.Function;
  agenticOps: lambda.Function;
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { stage, uploadUrlHandler, metadataQueryHandler, agenticOps } = props;

    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: `/aws/apigateway/CloudVisionOps-${stage}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.api = new apigateway.RestApi(this, 'CloudVisionOpsApi', {
      restApiName: `CloudVisionOps-API-${stage}`,
      description: 'CloudVisionOps serverless image intelligence API',
      deployOptions: {
        stageName: stage,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: stage !== 'prod',
        metricsEnabled: true,
        throttlingBurstLimit: 100,
        throttlingRateLimit: 50,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogs),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        tracingEnabled: true, // X-Ray tracing on API Gateway
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Idempotency-Key'],
        maxAge: cdk.Duration.minutes(10),
      },
    });

    // Request validator — enforces schema at the gateway before Lambda is even invoked
    const requestValidator = new apigateway.RequestValidator(this, 'RequestValidator', {
      restApi: this.api,
      requestValidatorName: 'validate-body-and-params',
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    // POST /uploads/presign — returns pre-signed S3 URL for direct browser upload
    const uploads = this.api.root.addResource('uploads');
    const presign = uploads.addResource('presign');
    presign.addMethod('POST', new apigateway.LambdaIntegration(uploadUrlHandler, {
      proxy: true,
      timeout: cdk.Duration.seconds(10),
    }), {
      requestValidator,
      requestModels: {
        'application/json': new apigateway.Model(this, 'PresignRequestModel', {
          restApi: this.api,
          contentType: 'application/json',
          modelName: 'PresignRequest',
          schema: {
            type: apigateway.JsonSchemaType.OBJECT,
            required: ['fileName', 'contentType', 'fileSize'],
            properties: {
              fileName: { type: apigateway.JsonSchemaType.STRING },
              contentType: {
                type: apigateway.JsonSchemaType.STRING,
                enum: ['image/jpeg', 'image/png'],
              },
              fileSize: { type: apigateway.JsonSchemaType.INTEGER, minimum: 1, maximum: 10485760 },
              userId: { type: apigateway.JsonSchemaType.STRING },
            },
          },
        }),
      },
    });

    // GET /images — list recent images (paginated)
    const images = this.api.root.addResource('images');
    images.addMethod('GET', new apigateway.LambdaIntegration(metadataQueryHandler, { proxy: true }));

    // GET /images/{imageId} — get single image metadata
    const image = images.addResource('{imageId}');
    image.addMethod('GET', new apigateway.LambdaIntegration(metadataQueryHandler, { proxy: true }));

    // GET /metrics/summary — aggregated pipeline metrics
    const metrics = this.api.root.addResource('metrics');
    const summary = metrics.addResource('summary');
    summary.addMethod('GET', new apigateway.LambdaIntegration(metadataQueryHandler, { proxy: true }));

    // GET /agent/runs — latest agentic ops run history
    // POST /agent/runs/trigger — manually trigger an agentic ops run
    const agentResource = this.api.root.addResource('agent');
    const agentRunsResource = agentResource.addResource('runs');
    agentRunsResource.addMethod('GET', new apigateway.LambdaIntegration(metadataQueryHandler));
    const agentTriggerResource = agentRunsResource.addResource('trigger');
    agentTriggerResource.addMethod('POST', new apigateway.LambdaIntegration(agenticOps));

    // GET /health
    const health = this.api.root.addResource('health');
    health.addMethod('GET', new apigateway.MockIntegration({
      integrationResponses: [{ statusCode: '200', responseTemplates: { 'application/json': '{"status":"ok"}' } }],
      passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
      requestTemplates: { 'application/json': '{"statusCode": 200}' },
    }), {
      methodResponses: [{ statusCode: '200' }],
    });

    // Usage plan with API key for rate limiting
    const usagePlan = new apigateway.UsagePlan(this, 'UsagePlan', {
      name: `CloudVisionOps-UsagePlan-${stage}`,
      throttle: { burstLimit: 100, rateLimit: 50 },
      quota: { limit: 10000, period: apigateway.Period.DAY },
    });
    usagePlan.addApiStage({ api: this.api, stage: this.api.deploymentStage });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      exportName: `${id}-ApiUrl`,
    });

    new cdk.CfnOutput(this, 'ApiId', {
      value: this.api.restApiId,
      exportName: `${id}-ApiId`,
    });
  }
}
