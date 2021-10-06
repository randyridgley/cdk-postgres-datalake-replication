import { InstanceClass, InstanceSize, InstanceType, Port, SecurityGroup, Vpc } from '@aws-cdk/aws-ec2';
import { DatabaseInstance, DatabaseInstanceEngine, ParameterGroup, PostgresEngineVersion } from '@aws-cdk/aws-rds';
import { Secret } from '@aws-cdk/aws-secretsmanager';
import { Construct, RemovalPolicy } from '@aws-cdk/core';

export interface RDSPostgresDatabaseProps {
  readonly vpc: Vpc;
  readonly adminUsername: string;
  readonly databaseName: string;
}

export class RDSPostgresDatabase extends Construct {
  public readonly database: DatabaseInstance;
  public readonly securitygroup: SecurityGroup;
  public readonly adminPassword: Secret;

  constructor(scope: Construct, id: string, props: RDSPostgresDatabaseProps) {
    super(scope, id);

    const parameterGroup = new ParameterGroup(this, 'ParameterGroup', {
      engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_13 }),
      parameters: {
        'rds.logical_replication': '1',
        'wal_sender_timeout': '0',
      },
    });

    this.adminPassword = new Secret(this, 'DBCredentialsSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'dbAdmin',
        }),
        excludePunctuation: true,
        includeSpace: false,
        excludeCharacters: '+%;:{}',
        generateStringKey: 'password',
      },
    });

    this.securitygroup = new SecurityGroup(this, 'DBSecurityGroup', {
      vpc: props.vpc,
    });
    this.securitygroup.addIngressRule(this.securitygroup, Port.allTraffic());

    this.database = new DatabaseInstance(this, 'DataLakeDB', {
      engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_13 }),
      parameterGroup,
      instanceType: InstanceType.of(InstanceClass.M5, InstanceSize.LARGE),
      credentials: {
        username: props.adminUsername,
        password: this.adminPassword.secretValueFromJson('password'),
      },
      allocatedStorage: 20,
      databaseName: props.databaseName,
      removalPolicy: RemovalPolicy.DESTROY,
      deleteAutomatedBackups: true,
      securityGroups: [this.securitygroup],
      vpc: props.vpc,
      deletionProtection: false,
    });
    this.adminPassword.attach(this.database);
  }
}