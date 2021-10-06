import { join } from 'path';
import { Dashboard, GraphWidget, MathExpression, Metric } from '@aws-cdk/aws-cloudwatch';
import { SecurityGroup, Vpc } from '@aws-cdk/aws-ec2';
import { DockerImageAsset } from '@aws-cdk/aws-ecr-assets';
import { AwsLogDriver, Cluster, ContainerImage, FargateService, FargateTaskDefinition, PropagatedTagSource, Secret } from '@aws-cdk/aws-ecs';
import { Effect, Policy, PolicyStatement, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
import { Stream } from '@aws-cdk/aws-kinesis';
import { CfnDeliveryStream } from '@aws-cdk/aws-kinesisfirehose';
import { LogGroup, RetentionDays } from '@aws-cdk/aws-logs';
import { Bucket } from '@aws-cdk/aws-s3';
import { CfnResource, Construct, RemovalPolicy, Tags } from '@aws-cdk/core';

export interface ReplicationTaskProps {
  readonly vpc: Vpc;
  readonly databases: DatabaseReplicationProps[];
  readonly dashboard?: Dashboard;
}

export interface DatabaseReplicationProps {
  readonly userName: string;
  readonly password: Secret;
  readonly hostName: string;
  readonly databaseName: string;
  readonly securityGroup: SecurityGroup;
}

export class DatabaseReplicationTask extends Construct {
  public readonly replicationStream: Stream;
  public readonly cluster: Cluster;
  public readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: ReplicationTaskProps) {
    super(scope, id);

    this.replicationStream = new Stream(this, 'KinesisReplicationStream', {
      shardCount: 1,
      streamName: 'replicationStream',
    });

    const replicationService = new DockerImageAsset(this, 'ReplicationService', {
      directory: join(__dirname, '..', 'replication-service'),
    });

    this.cluster = new Cluster(this, 'FargateReplicationCluster', {
      vpc: props.vpc,
    });

    const role = new Role(this, 'StreamRole', {
      assumedBy: new ServicePrincipal('firehose.amazonaws.com'),
    });

    props.databases.forEach(db => {
      const replicationServiceTask = new FargateTaskDefinition(this, 'replicationServiceTask', {
        cpu: 1024,
        memoryLimitMiB: 2048,
      });
      this.replicationStream.grantWrite(replicationServiceTask.taskRole);
      Tags.of(replicationServiceTask).add('RDSHost', db.hostName);

      replicationServiceTask.addContainer('replicationServiceContainer', {
        image: ContainerImage.fromDockerImageAsset(replicationService),
        environment: {
          POSTGRES_USER: db.userName,
          POSTGRES_HOST: db.hostName,
          POSTGRES_DB: db.databaseName,
          REPLICATION_KINESIS_STREAM_NAME: this.replicationStream.streamName,
          REPLICATION_SLOT_NAME: 'wal2json',
        },
        secrets: {
          POSTGRES_PASSWORD: db.password,
        },
        cpu: 1024,
        memoryLimitMiB: 2048,
        logging: new AwsLogDriver({
          streamPrefix: 'replicationService',
        }),
      });

      new FargateService(this, 'ReplicationFargateService', {
        serviceName: 'pg2kinesis',
        cluster: this.cluster,
        taskDefinition: replicationServiceTask,
        desiredCount: 1,
        securityGroups: [db.securityGroup],
        enableECSManagedTags: true,
        propagateTags: PropagatedTagSource.TASK_DEFINITION,
      });
    });

    this.bucket = new Bucket(this, 'DataLakeBucket', {
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const logGroup = new LogGroup(this, 'KinesisLogGroup', {
      logGroupName: '/aws/deliverystream/',
      removalPolicy: RemovalPolicy.DESTROY,
      retention: RetentionDays.ONE_DAY,
    });

    const firehosePolicy = new Policy(this, 'FirehoseKinesisPolicy', {
      roles: [role],
      statements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['kinesis:DescribeStream',
            'kinesis:GetShardIterator',
            'kinesis:GetRecords'],
          resources: [this.replicationStream.streamArn],
        }),
      ],
    });

    this.replicationStream.grantRead(role);
    this.bucket.grantReadWrite(role);
    logGroup.grantWrite(role);

    const firehose = new CfnDeliveryStream(this, 'DynamicDeliveryStream', {
      deliveryStreamName: 'wal2jsonStream',
      deliveryStreamType: 'KinesisStreamAsSource',
      kinesisStreamSourceConfiguration: {
        kinesisStreamArn: this.replicationStream.streamArn,
        roleArn: role.roleArn,
      },
      extendedS3DestinationConfiguration: {
        roleArn: role.roleArn,
        bucketArn: this.bucket.bucketArn,
        dynamicPartitioningConfiguration: {
          enabled: true,
          retryOptions: {
            durationInSeconds: 10,
          },
        },
        cloudWatchLoggingOptions: {
          logGroupName: logGroup.logGroupName,
          enabled: true,
          logStreamName: '/wall2json',
        },
        prefix: 'schema=!{partitionKeyFromQuery:schema}/table=!{partitionKeyFromQuery:table}/',
        errorOutputPrefix: 'error/',
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'AppendDelimiterToRecord',
              parameters: [],
            },
            {
              type: 'MetadataExtraction',
              parameters: [
                {
                  parameterName: 'MetadataExtractionQuery',
                  parameterValue: '{schema:.schema,table:.table}',
                },
                {
                  parameterName: 'JsonParsingEngine',
                  parameterValue: 'JQ-1.6',
                },
              ],
            },
          ],
        },
      },
    });
    firehose.addDependsOn(firehosePolicy.node.defaultChild as CfnResource);

    if (props.dashboard) {
      props.dashboard.addWidgets(
        this.graphWidget('Get records - sum (Bytes)', this.replicationStream.metricGetRecordsBytes({ statistic: 'Sum' })),
        this.graphWidget('Get records iterator age - maximum (Milliseconds)', this.replicationStream.metricGetRecordsIteratorAgeMilliseconds()),
        this.graphWidget('Get records latency - average (Milliseconds)', this.replicationStream.metricGetRecordsLatency()),
        this.graphWidget('Get records - sum (Count)', this.replicationStream.metricGetRecords({ statistic: 'Sum' })),
        this.graphWidget('Get records success - average (Percent)', this.replicationStream.metricGetRecordsSuccess()),
        this.graphWidget('Incoming data - sum (Bytes)', this.replicationStream.metricIncomingBytes({ statistic: 'Sum' })),
        this.graphWidget('Incoming records - sum (Count)', this.replicationStream.metricIncomingRecords({ statistic: 'Sum' })),
        this.graphWidget('Put record - sum (Bytes)', this.replicationStream.metricPutRecordBytes({ statistic: 'Sum' })),
        this.graphWidget('Put record latency - average (Milliseconds)', this.replicationStream.metricPutRecordLatency()),
        this.graphWidget('Put record success - average (Percent)', this.replicationStream.metricPutRecordSuccess()),
        this.graphWidget('Put records - sum (Bytes)', this.replicationStream.metricPutRecordsBytes({ statistic: 'Sum' })),
        this.graphWidget('Put records latency - average (Milliseconds)', this.replicationStream.metricPutRecordsLatency()),
        this.graphWidget('Read throughput exceeded - average (Percent)', this.replicationStream.metricReadProvisionedThroughputExceeded()),
        this.graphWidget('Write throughput exceeded - average (Count)', this.replicationStream.metricWriteProvisionedThroughputExceeded()),
        this.percentGraphWidget('Put records successful records - average (Percent)',
          this.replicationStream.metricPutRecordsSuccessfulRecords(), this.replicationStream.metricPutRecordsTotalRecords()),
        this.percentGraphWidget('Put records failed records - average (Percent)',
          this.replicationStream.metricPutRecordsFailedRecords(), this.replicationStream.metricPutRecordsTotalRecords()),
        this.percentGraphWidget('Put records throttled records - average (Percent)',
          this.replicationStream.metricPutRecordsThrottledRecords(), this.replicationStream.metricPutRecordsTotalRecords()),
      );
    }
  }

  graphWidget(title: string, metric: Metric) {
    return new GraphWidget({
      title,
      left: [metric],
      width: 12,
      height: 5,
    });
  }

  // helper function to create a GraphWidget of percentage ""(count / total) * 100"
  percentGraphWidget(title: string, countMetric: Metric, totalMetric: Metric) {
    return new GraphWidget({
      title,
      left: [new MathExpression({
        expression: '( count / total ) * 100',
        usingMetrics: {
          count: countMetric,
          total: totalMetric,
        },
      })],
      width: 12,
      height: 5,
    });
  }
}