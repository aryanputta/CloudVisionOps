# Multi-stage build — compiles TypeScript with esbuild, then copies single
# bundled JS into the Lambda runtime image. AWS SDKs are externalized because
# they are pre-installed in the Node.js 20 Lambda base image, keeping the
# final image small and eliminating the node_modules cold-start load time.

FROM public.ecr.aws/lambda/nodejs:20 AS builder

WORKDIR /build

# Copy shared utilities and the processor source
COPY shared/ ./shared/
COPY lambdas/rekognition-processor/ ./processor/

WORKDIR /build/processor

# esbuild bundles index.ts + shared/utils.ts into a single file.
# AWS SDK packages are marked external — they exist in the Lambda runtime.
RUN npm install -g esbuild@0.21 && \
    esbuild index.ts \
      --bundle \
      --platform=node \
      --target=node20 \
      --external:@aws-sdk/client-s3 \
      --external:@aws-sdk/client-rekognition \
      --external:@aws-sdk/lib-dynamodb \
      --external:@aws-sdk/client-dynamodb \
      --external:@aws-sdk/client-sqs \
      --outfile=dist/index.js

# ---- Runtime image ----
FROM public.ecr.aws/lambda/nodejs:20

WORKDIR ${LAMBDA_TASK_ROOT}

COPY --from=builder /build/processor/dist/index.js ./

CMD ["index.handler"]
