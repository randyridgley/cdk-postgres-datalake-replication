import { readFileSync } from 'fs';
import { Dashboard } from '@aws-cdk/aws-cloudwatch';
import { InterfaceVpcEndpointAwsService, Vpc } from '@aws-cdk/aws-ec2';
import * as ecs from '@aws-cdk/aws-ecs';
import { ManagedPolicy, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
import { CfnNotebookInstance, CfnNotebookInstanceLifecycleConfig } from '@aws-cdk/aws-sagemaker';
import { App, CfnOutput, Construct, Fn, Stack, StackProps } from '@aws-cdk/core';
import { RDSPostgresDatabase } from './rds-postgres-db';
import { DatabaseReplicationTask } from './replication-task';

export class KinesisStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const dashboard = new Dashboard(this, 'ReplicationStreamDashboard');

    const vpc = new Vpc(this, 'ReplicationVPC', {
      maxAzs: 2,
      natGateways: 1,
    });
    vpc.addInterfaceEndpoint('sageMakerNotebookEndpoint', {
      service: InterfaceVpcEndpointAwsService.SAGEMAKER_NOTEBOOK,
    });

    const adminUsername = 'dbAdmin';
    const databaseName = 'employee';

    const lakeDb = new RDSPostgresDatabase(this, 'LakeDB', {
      adminUsername: adminUsername,
      databaseName: databaseName,
      vpc: vpc,
    });

    new CfnOutput(this, 'LakeDatabaseHostname', { value: lakeDb.database.instanceEndpoint.hostname });

    new DatabaseReplicationTask(this, 'DatabaseReplicationTask', {
      vpc: vpc,
      dashboard: dashboard,
      databases: [
        {
          databaseName: databaseName,
          hostName: lakeDb.database.instanceEndpoint.hostname,
          password: ecs.Secret.fromSecretsManager(lakeDb.adminPassword, 'password'),
          securityGroup: lakeDb.securitygroup,
          userName: adminUsername,
        },
      ],
    });

    let onStartScript = readFileSync('scripts/onStart.sh', 'utf8');
    let onCreateScript = readFileSync('scripts/onCreate.sh', 'utf8');

    /** Create the IAM Role to be used by SageMaker */
    const sagemakerRole = new Role(this, 'notebook-role', {
      assumedBy: new ServicePrincipal('sagemaker.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess'),
        ManagedPolicy.fromAwsManagedPolicyName('IAMReadOnlyAccess'),
      ],
    });

    /** Create the SageMaker Notebook Lifecycle Config */
    const lifecycleConfig = new CfnNotebookInstanceLifecycleConfig(this, 'LifecycleConfig', {
      notebookInstanceLifecycleConfigName: 'SagemakerLifecycleConfig',
      onCreate: [
        {
          content: Fn.base64(onCreateScript!),
        },
      ],
      onStart: [
        {
          content: Fn.base64(onStartScript!),
        },
      ],
    });

    new CfnNotebookInstance(this, 'SagemakerNotebook', {
      notebookInstanceName: 'replicationServiceNotebook',
      lifecycleConfigName: lifecycleConfig.notebookInstanceLifecycleConfigName,
      roleArn: sagemakerRole.roleArn,
      instanceType: 'ml.t2.medium',
      subnetId: vpc.privateSubnets[0].subnetId,
      securityGroupIds: [lakeDb.securitygroup.securityGroupId],
    });
  }
}

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new KinesisStack(app, 'ReplicationDatabaseStack', { env: devEnv });

app.synth();