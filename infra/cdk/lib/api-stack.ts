import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface ApiStackProps extends cdk.StackProps {
  stage: string;
  uploadUrlHandler: lambda.Function;
  metadataQueryHandler: lambda.Function;
  agenticOps: lambda.Function;
  userPool: cognito.UserPool;
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { stage, uploadUrlHandler, metadataQueryHandler, agenticOps, userPool } = props;

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
        tracingEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Idempotency-Key'],
        maxAge: cdk.Duration.minutes(10),
      },
    });

    // Cognito JWT authorizer — validates Bearer token on all protected routes
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: `CloudVisionOps-CognitoAuthorizer-${stage}`,
      identitySource: 'method.request.header.Authorization',
      resultsCacheTtl: cdk.Duration.minutes(5),
    });

    const cognitoAuth = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // Request validator — enforces schema at the gateway before Lambda is invoked
    const requestValidator = new apigateway.RequestValidator(this, 'RequestValidator', {
      restApi: this.api,
      requestValidatorName: 'validate-body-and-params',
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    // POST /uploads/presign — protected: only authenticated users can get upload URLs
    const uploads = this.api.root.addResource('uploads');
    const presign = uploads.addResource('presign');
    presign.addMethod('POST', new apigateway.LambdaIntegration(uploadUrlHandler, {
      proxy: true,
      timeout: cdk.Duration.seconds(10),
    }), {
      ...cognitoAuth,
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

    // GET /images — protected
    const images = this.api.root.addResource('images');
    images.addMethod('GET', new apigateway.LambdaIntegration(metadataQueryHandler, { proxy: true }), cognitoAuth);

    // GET /images/{imageId} — protected
    const image = images.addResource('{imageId}');
    image.addMethod('GET', new apigateway.LambdaIntegration(metadataQueryHandler, { proxy: true }), cognitoAuth);

    // GET /metrics/summary — protected
    const metrics = this.api.root.addResource('metrics');
    const summary = metrics.addResource('summary');
    summary.addMethod('GET', new apigateway.LambdaIntegration(metadataQueryHandler, { proxy: true }), cognitoAuth);

    // GET /agent/runs — protected
    // POST /agent/runs/trigger — protected
    const agentResource = this.api.root.addResource('agent');
    const agentRunsResource = agentResource.addResource('runs');
    agentRunsResource.addMethod('GET', new apigateway.LambdaIntegration(metadataQueryHandler), cognitoAuth);
    const agentTriggerResource = agentRunsResource.addResource('trigger');
    agentTriggerResource.addMethod('POST', new apigateway.LambdaIntegration(agenticOps), cognitoAuth);

    // GET /health — open, no auth (used by CI smoke tests and load balancer checks)
    const health = this.api.root.addResource('health');
    health.addMethod('GET', new apigateway.MockIntegration({
      integrationResponses: [{ statusCode: '200', responseTemplates: { 'application/json': '{"status":"ok"}' } }],
      passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
      requestTemplates: { 'application/json': '{"statusCode": 200}' },
    }), {
      methodResponses: [{ statusCode: '200' }],
    });

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
