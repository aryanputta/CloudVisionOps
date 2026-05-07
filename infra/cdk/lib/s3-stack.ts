import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

interface S3StackProps extends cdk.StackProps {
  stage: string;
}

export class S3Stack extends cdk.Stack {
  public readonly uploadBucket: s3.Bucket;
  public readonly accessLogsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: S3StackProps) {
    super(scope, id, props);

    const { stage } = props;

    this.accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      bucketName: `cloudvisionops-access-logs-${stage}-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          id: 'expire-old-logs',
          expiration: cdk.Duration.days(90),
          enabled: true,
        },
      ],
    });

    this.uploadBucket = new s3.Bucket(this, 'UploadBucket', {
      bucketName: `cloudvisionops-uploads-${stage}-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'upload-bucket/',
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          id: 'transition-to-ia',
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
          enabled: true,
        },
        {
          id: 'expire-old-uploads',
          expiration: cdk.Duration.days(365),
          noncurrentVersionExpiration: cdk.Duration.days(30),
          enabled: true,
        },
      ],
    });

    new cdk.CfnOutput(this, 'UploadBucketName', {
      value: this.uploadBucket.bucketName,
      exportName: `${id}-UploadBucketName`,
    });

    new cdk.CfnOutput(this, 'UploadBucketArn', {
      value: this.uploadBucket.bucketArn,
      exportName: `${id}-UploadBucketArn`,
    });
  }
}
