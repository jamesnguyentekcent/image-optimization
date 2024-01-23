// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Fn, Stack, StackProps, RemovalPolicy, aws_s3 as s3, aws_s3_deployment as s3deploy, aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_lambda as lambda, aws_iam as iam, Duration, CfnOutput, aws_logs as logs } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { getOriginShieldRegion } from './origin-shield';
import { createHash } from 'crypto';
import * as cdk from 'aws-cdk-lib';

// Stack Parameters
const stack = cdk.Stack.of(this);
var SERVICE_PREFIX = stack.stackName;

// Parameters of S3 bucket where original images are stored
var S3_IMAGE_BUCKET_NAME: string;
var AUTO_TRANSFORM_IMAGE_SIZES = 'org';
var AUTO_TRANSFORM_IMAGE_FORMATS = 'org';
var ALLOW_TRANSFORM_IMAGE_WIDTHS = '';
var ALLOW_TRANSFORM_IMAGE_HEIGHTS = '';
// CloudFront parameters
var CLOUDFRONT_ORIGIN_SHIELD_REGION = getOriginShieldRegion(process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1');
var CLOUDFRONT_CORS_ENABLED = 'true';
// Parameters of transformed images
var S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = '90';
var S3_TRANSFORMED_IMAGE_CACHE_TTL = 'max-age=31622400';
// Max image size in bytes. If generated images are stored on S3, bigger images are generated, stored on S3
// and request is redirect to the generated image. Otherwise, an application error is sent.
var MAX_IMAGE_SIZE = '4700000';
// Lambda Parameters
var LAMBDA_MEMORY = '1500';
var LAMBDA_TIMEOUT = '60';

type ImageDeliveryCacheBehaviorConfig = {
  origin: any;
  viewerProtocolPolicy: any;
  cachePolicy: any;
  functionAssociations: any;
  responseHeadersPolicy?: any;
};

type LambdaEnv = {
  originalImageBucketName: string,
  transformedImageBucketName?: any;
  transformedImageCacheTTL: string,
  secretKey: string,
  maxImageSize: string,
  autoTransformImageSizes: string,
  autoTransformImageFormats: string,
  allowTransformImageWidths: string,
  allowTransformImageHeights: string
}

export class ImageOptimizationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Change stack parameters based on provided context
    S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION') || S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION;
    S3_TRANSFORMED_IMAGE_CACHE_TTL = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_CACHE_TTL') || S3_TRANSFORMED_IMAGE_CACHE_TTL;
    S3_IMAGE_BUCKET_NAME = this.node.tryGetContext('S3_IMAGE_BUCKET_NAME') || S3_IMAGE_BUCKET_NAME;
    AUTO_TRANSFORM_IMAGE_SIZES = this.node.tryGetContext('AUTO_TRANSFORM_IMAGE_SIZES') || AUTO_TRANSFORM_IMAGE_SIZES;
    AUTO_TRANSFORM_IMAGE_FORMATS = this.node.tryGetContext('AUTO_TRANSFORM_IMAGE_FORMATS') || AUTO_TRANSFORM_IMAGE_FORMATS;
    ALLOW_TRANSFORM_IMAGE_WIDTHS = this.node.tryGetContext('ALLOW_TRANSFORM_IMAGE_WIDTHS') || ALLOW_TRANSFORM_IMAGE_WIDTHS;
    ALLOW_TRANSFORM_IMAGE_HEIGHTS = this.node.tryGetContext('ALLOW_TRANSFORM_IMAGE_HEIGHTS') || ALLOW_TRANSFORM_IMAGE_HEIGHTS;
    CLOUDFRONT_ORIGIN_SHIELD_REGION = this.node.tryGetContext('CLOUDFRONT_ORIGIN_SHIELD_REGION') || CLOUDFRONT_ORIGIN_SHIELD_REGION;
    CLOUDFRONT_CORS_ENABLED = this.node.tryGetContext('CLOUDFRONT_CORS_ENABLED') || CLOUDFRONT_CORS_ENABLED;
    LAMBDA_MEMORY = this.node.tryGetContext('LAMBDA_MEMORY') || LAMBDA_MEMORY;
    LAMBDA_TIMEOUT = this.node.tryGetContext('LAMBDA_TIMEOUT') || LAMBDA_TIMEOUT;
    MAX_IMAGE_SIZE = this.node.tryGetContext('MAX_IMAGE_SIZE') || MAX_IMAGE_SIZE;

    // Create secret key to be used between CloudFront and Lambda URL for access control
    const SECRET_KEY = createHash('md5').update(this.node.addr).digest('hex');

    // For the bucket having original images, either use an external one, or create one with some samples photos.
    var originalImageBucket;
    var transformedImageBucket;

    // create original image bucket
    originalImageBucket = new s3.Bucket(this, 's3-original', {
      bucketName: SERVICE_PREFIX + '-s3-original',
      removalPolicy: RemovalPolicy.DESTROY,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      autoDeleteObjects: true,
    });
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset('./image-sample')],
      destinationBucket: originalImageBucket,
      destinationKeyPrefix: 'sample/',
    });
    new CfnOutput(this, 'OriginalImagesS3Bucket', {
      description: 'S3 bucket where original images are stored',
      value: originalImageBucket.bucketName
    });


    // create bucket for transformed images
    transformedImageBucket = new s3.Bucket(this, 's3-transformed', {
	  bucketName: SERVICE_PREFIX + '-s3-transformed',
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: Duration.days(parseInt(S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION)),
        },
      ],
    });
    

    // prepare env variable for Lambda 
    var lambdaEnv: LambdaEnv = {
      originalImageBucketName: originalImageBucket.bucketName,
      transformedImageCacheTTL: S3_TRANSFORMED_IMAGE_CACHE_TTL,
      secretKey: SECRET_KEY,
      maxImageSize: MAX_IMAGE_SIZE,
      autoTransformImageSizes: AUTO_TRANSFORM_IMAGE_SIZES,
      autoTransformImageFormats: AUTO_TRANSFORM_IMAGE_FORMATS,
      allowTransformImageWidths: ALLOW_TRANSFORM_IMAGE_WIDTHS,
      allowTransformImageHeights: ALLOW_TRANSFORM_IMAGE_HEIGHTS,
    };
    if (transformedImageBucket) lambdaEnv.transformedImageBucketName = transformedImageBucket.bucketName;

    // IAM policy to read from the S3 bucket containing the original images
    const s3ReadOriginalImagesPolicy = new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: ['arn:aws:s3:::' + originalImageBucket.bucketName + '/*'],
    });

    // statements of the IAM policy to attach to Lambda
    var iamPolicyStatements = [s3ReadOriginalImagesPolicy];

    // Create Lambda for image processing
    var lambdaProps = {
      functionName: SERVICE_PREFIX + '-image-processing',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/image-processing'),
      timeout: Duration.seconds(parseInt(LAMBDA_TIMEOUT)),
      memorySize: parseInt(LAMBDA_MEMORY),
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_DAY,
    };
    var imageProcessing = new lambda.Function(this, 'image-optimization', lambdaProps);

    // Enable Lambda URL
    const imageProcessingURL = imageProcessing.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // Leverage CDK Intrinsics to get the hostname of the Lambda URL 
    const imageProcessingDomainName = Fn.parseDomainName(imageProcessingURL.url);

    // Create a CloudFront origin: S3 with fallback to Lambda when image needs to be transformed, otherwise with Lambda as sole origin
    var imageOrigin;

    if (transformedImageBucket) {
      imageOrigin = new origins.OriginGroup({
        primaryOrigin: new origins.S3Origin(transformedImageBucket, {
          originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
        }),
        fallbackOrigin: new origins.HttpOrigin(imageProcessingDomainName, {
          originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
          customHeaders: {
            'x-origin-secret-header': SECRET_KEY,
          },
        }),
        fallbackStatusCodes: [403, 500, 503, 504],
      });

      // write policy for Lambda on the s3 bucket for transformed images
      var s3WriteTransformedImagesPolicy = new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: ['arn:aws:s3:::' + transformedImageBucket.bucketName + '/*'],
      });
      iamPolicyStatements.push(s3WriteTransformedImagesPolicy);

      // write log policy for Lambda on the s3 bucket
      var s3LogPolicy = new iam.PolicyStatement({
        actions: ['logs:PutLogEvents', 'logs:CreateLogGroup', 'logs:CreateLogStream'],
        resources: ['arn:aws:logs:*:*:*'],
      });
      iamPolicyStatements.push(s3LogPolicy);
    } else {
      imageOrigin = new origins.HttpOrigin(imageProcessingDomainName, {
        originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
        customHeaders: {
          'x-origin-secret-header': SECRET_KEY,
        },
      });
    }

    // attach iam policy to the role assumed by Lambda
    imageProcessing.role?.attachInlinePolicy(
      new iam.Policy(this, 'read-write-bucket-policy', {
        policyName: SERVICE_PREFIX + '-read-write-bucket-policy',
        statements: iamPolicyStatements,
      }),
    );

    // Create a CloudFront Function for url rewrites
    const urlRewriteFunction = new cloudfront.Function(this, 'urlRewrite', {
      code: cloudfront.FunctionCode.fromFile({ filePath: 'functions/url-rewrite/index.js', }),
      functionName: SERVICE_PREFIX + '-url-rewrite',
    });

    var imageDeliveryCacheBehaviorConfig: ImageDeliveryCacheBehaviorConfig = {
      origin: imageOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: new cloudfront.CachePolicy(this, `ImageCachePolicy${this.node.addr}`, {
	    cachePolicyName: SERVICE_PREFIX + '-cache-policy',
        defaultTtl: Duration.hours(24),
        maxTtl: Duration.days(365),
        minTtl: Duration.seconds(0),
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.all()
      }),
      functionAssociations: [{
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: urlRewriteFunction,
      }],
    }

    if (CLOUDFRONT_CORS_ENABLED === 'true') {
      // Creating a custom response headers policy. CORS allowed for all origins.
      const imageResponseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, `ResponseHeadersPolicy${this.node.addr}`, {
        responseHeadersPolicyName: SERVICE_PREFIX + '-image-response-policy',
        corsBehavior: {
          accessControlAllowCredentials: false,
          accessControlAllowHeaders: ['*'],
          accessControlAllowMethods: ['GET'],
          accessControlAllowOrigins: ['*'],
          accessControlMaxAge: Duration.seconds(600),
          originOverride: false,
        },
        // recognizing image requests that were processed by this solution
        customHeadersBehavior: {
          customHeaders: [
            { header: 'x-aws-image-optimization', value: 'v1.0', override: true },
            { header: 'vary', value: 'accept', override: true },
          ],
        }
      });
      imageDeliveryCacheBehaviorConfig.responseHeadersPolicy = imageResponseHeadersPolicy;
    }
    const imageDelivery = new cloudfront.Distribution(this, 'delivery', {
      comment: 'SPL TP Crafter CloudFront Delivery',
      defaultBehavior: imageDeliveryCacheBehaviorConfig
    });

    new CfnOutput(this, 'ImageDeliveryDomain', {
      description: 'Domain name of delivery distribution',
      value: imageDelivery.distributionDomainName
    });
  }
}
