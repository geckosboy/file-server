import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
	AclOperationTypes,
	AclPermissionTypes,
	AclResourceTypes,
	Admin,
	Kafka,
	KafkaConfig,
	logLevel,
	ResourcePatternTypes,
	SASLOptions,
} from 'kafkajs';
import {
	createClientLifecyclePrincipal,
	createClientLifecycleTopic,
} from '@file/telemetry-contracts/lifecycle-topics';
import { readFileSync } from 'fs';
import {
	ClientServiceLifecycleProvisioningRecord,
	ClientServiceLifecycleProvisioningStatus,
} from './client-services.types';

export const LIFECYCLE_KAFKA_ADMIN_FACTORY = Symbol(
	'LIFECYCLE_KAFKA_ADMIN_FACTORY',
);

type KafkaAdmin = Pick<
	Admin,
	'connect' | 'disconnect' | 'createTopics' | 'createAcls' | 'deleteAcls'
>;
type KafkaAdminFactory = () => KafkaAdmin;

@Injectable()
export class KafkaLifecycleProvisionerService {
	private readonly logger = new Logger(KafkaLifecycleProvisionerService.name);

	constructor(
		@Optional()
		@Inject(LIFECYCLE_KAFKA_ADMIN_FACTORY)
		private readonly injectedAdminFactory?: KafkaAdminFactory,
	) {}

	async provision({
		clientServiceId,
		consumerGroup,
		previousConsumerGroup,
		subscriptionEnabled,
	}: {
		clientServiceId: string;
		consumerGroup: string;
		previousConsumerGroup?: string;
		subscriptionEnabled: boolean;
	}): Promise<ClientServiceLifecycleProvisioningRecord> {
		const topic = createClientLifecycleTopic(clientServiceId);
		const principal = createClientLifecyclePrincipal(clientServiceId);
		if (!subscriptionEnabled || !isProvisioningEnabled()) {
			return {
				topic,
				principal,
				provisioningStatus: ClientServiceLifecycleProvisioningStatus.Pending,
				provisioningError: null,
				provisionedAt: null,
			};
		}

		const admin = this.createAdmin();
		try {
			await admin.connect();
			await admin.createTopics({
				waitForLeaders: true,
				topics: [
					{
						topic,
						numPartitions: readPositiveInteger(
							process.env.LIFECYCLE_CLIENT_TOPIC_PARTITIONS,
							6,
						),
						replicationFactor: readPositiveInteger(
							process.env.LIFECYCLE_CLIENT_TOPIC_REPLICATION_FACTOR,
							3,
						),
						configEntries: [
							{
								name: 'min.insync.replicas',
								value: String(
									readPositiveInteger(
										process.env.LIFECYCLE_CLIENT_TOPIC_MIN_ISR,
										2,
									),
								),
							},
						],
					},
				],
			});
			await admin.createAcls({
				acl: [
					createAllowAcl({
						resourceType: AclResourceTypes.TOPIC,
						resourceName: topic,
						principal,
						operation: AclOperationTypes.READ,
					}),
					createAllowAcl({
						resourceType: AclResourceTypes.TOPIC,
						resourceName: topic,
						principal,
						operation: AclOperationTypes.DESCRIBE,
					}),
					createAllowAcl({
						resourceType: AclResourceTypes.GROUP,
						resourceName: consumerGroup,
						principal,
						operation: AclOperationTypes.READ,
					}),
				],
			});
			if (previousConsumerGroup && previousConsumerGroup !== consumerGroup) {
				await admin.deleteAcls({
					filters: [
						{
							resourceType: AclResourceTypes.GROUP,
							resourceName: previousConsumerGroup,
							resourcePatternType: ResourcePatternTypes.LITERAL,
							principal,
							host: '*',
							operation: AclOperationTypes.READ,
							permissionType: AclPermissionTypes.ALLOW,
						},
					],
				});
			}

			return {
				topic,
				principal,
				provisioningStatus:
					ClientServiceLifecycleProvisioningStatus.Provisioned,
				provisioningError: null,
				provisionedAt: new Date().toISOString(),
			};
		} catch (error) {
			const provisioningError = errorToMessage(error).slice(0, 1_000);
			this.logger.error(
				`client lifecycle Kafka provisioning failed(clientServiceId=${clientServiceId}, topic=${topic}): ${provisioningError}`,
			);
			return {
				topic,
				principal,
				provisioningStatus: ClientServiceLifecycleProvisioningStatus.Failed,
				provisioningError,
				provisionedAt: null,
			};
		} finally {
			await admin.disconnect().catch((error) => {
				this.logger.warn(
					`Kafka admin disconnect failed: ${errorToMessage(error)}`,
				);
			});
		}
	}

	private createAdmin(): KafkaAdmin {
		return this.injectedAdminFactory
			? this.injectedAdminFactory()
			: new Kafka(readKafkaConfig()).admin({
					retry: {
						retries: readPositiveInteger(
							process.env.LIFECYCLE_TOPIC_ADMIN_RETRIES,
							5,
						),
					},
				});
	}
}

function createAllowAcl({
	resourceType,
	resourceName,
	principal,
	operation,
}: {
	resourceType: AclResourceTypes;
	resourceName: string;
	principal: string;
	operation: AclOperationTypes;
}) {
	return {
		resourceType,
		resourceName,
		resourcePatternType: ResourcePatternTypes.LITERAL,
		principal,
		host: '*',
		operation,
		permissionType: AclPermissionTypes.ALLOW,
	};
}

function isProvisioningEnabled(): boolean {
	const configured = process.env.LIFECYCLE_TOPIC_PROVISIONING_ENABLED;
	if (configured !== undefined) {
		return configured.trim().toLowerCase() === 'true';
	}
	return process.env.NODE_ENV === 'production';
}

function readKafkaConfig(): KafkaConfig {
	const brokers = (
		process.env.LIFECYCLE_TOPIC_ADMIN_BROKERS ??
		process.env.KAFKA_CLIENT_BROKERS ??
		''
	)
		.split(',')
		.map((broker) => broker.trim())
		.filter(Boolean);
	if (brokers.length === 0) {
		throw new Error('Kafka admin brokers are required');
	}

	return {
		clientId:
			process.env.LIFECYCLE_TOPIC_ADMIN_CLIENT_ID ??
			'file-lifecycle-topic-provisioner',
		brokers,
		ssl: readKafkaSsl(),
		sasl: readKafkaSasl(),
		logLevel: logLevel.ERROR,
	};
}

function readKafkaSsl(): KafkaConfig['ssl'] {
	if (process.env.KAFKA_SSL_ENABLED?.trim().toLowerCase() !== 'true') {
		return undefined;
	}
	const caFile = process.env.KAFKA_SSL_CA_FILE;
	return caFile
		? { ca: [readFileSync(caFile, 'utf8')], rejectUnauthorized: true }
		: true;
}

function readKafkaSasl(): SASLOptions | undefined {
	const mechanism = process.env.KAFKA_SASL_MECHANISM?.trim().toLowerCase();
	if (!mechanism) {
		return undefined;
	}
	if (!['plain', 'scram-sha-256', 'scram-sha-512'].includes(mechanism)) {
		throw new Error(`Unsupported Kafka SASL mechanism: ${mechanism}`);
	}
	const username = process.env.KAFKA_SASL_USERNAME;
	const password = process.env.KAFKA_SASL_PASSWORD;
	if (!username || !password) {
		throw new Error('Kafka SASL username and password are required');
	}
	return { mechanism, username, password } as SASLOptions;
}

function readPositiveInteger(value: string | undefined, fallback: number) {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function errorToMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
