import {
	AclOperationTypes,
	AclPermissionTypes,
	AclResourceTypes,
	ResourcePatternTypes,
} from 'kafkajs';
import { ClientServiceLifecycleProvisioningStatus } from '../client-services.types';
import { KafkaLifecycleProvisionerService } from '../kafka-lifecycle-provisioner.service';

describe('KafkaLifecycleProvisionerService', () => {
	const originalNodeEnv = process.env.NODE_ENV;
	const originalProvisioningEnabled =
		process.env.LIFECYCLE_TOPIC_PROVISIONING_ENABLED;
	let admin: {
		connect: jest.Mock;
		disconnect: jest.Mock;
		createTopics: jest.Mock;
		createAcls: jest.Mock;
		deleteAcls: jest.Mock;
	};

	beforeEach(() => {
		process.env.NODE_ENV = 'test';
		process.env.LIFECYCLE_TOPIC_PROVISIONING_ENABLED = 'true';
		admin = {
			connect: jest.fn().mockResolvedValue(undefined),
			disconnect: jest.fn().mockResolvedValue(undefined),
			createTopics: jest.fn().mockResolvedValue(true),
			createAcls: jest.fn().mockResolvedValue(true),
			deleteAcls: jest.fn().mockResolvedValue({ filterResponses: [] }),
		};
	});

	it('rotates the exact consumer-group ACL without widening topic access', async () => {
		const service = new KafkaLifecycleProvisionerService(() => admin);

		await service.provision({
			clientServiceId: 'service-1',
			consumerGroup: 'catalog-lifecycle-v2',
			previousConsumerGroup: 'catalog-lifecycle-v1',
			subscriptionEnabled: true,
		});

		expect(admin.deleteAcls).toHaveBeenCalledWith({
			filters: [
				{
					resourceType: AclResourceTypes.GROUP,
					resourceName: 'catalog-lifecycle-v1',
					resourcePatternType: ResourcePatternTypes.LITERAL,
					principal: 'User:file-lifecycle-service-1',
					host: '*',
					operation: AclOperationTypes.READ,
					permissionType: AclPermissionTypes.ALLOW,
				},
			],
		});
	});

	afterEach(() => {
		process.env.NODE_ENV = originalNodeEnv;
		if (originalProvisioningEnabled === undefined) {
			delete process.env.LIFECYCLE_TOPIC_PROVISIONING_ENABLED;
		} else {
			process.env.LIFECYCLE_TOPIC_PROVISIONING_ENABLED =
				originalProvisioningEnabled;
		}
	});

	it('creates the server-computed topic and only its topic/group consume ACLs', async () => {
		const service = new KafkaLifecycleProvisionerService(() => admin);

		await expect(
			service.provision({
				clientServiceId: 'service-1',
				consumerGroup: 'catalog-lifecycle',
				subscriptionEnabled: true,
			}),
		).resolves.toMatchObject({
			topic: 'file.image.lifecycle.client.service-1.v1',
			principal: 'User:file-lifecycle-service-1',
			provisioningStatus: ClientServiceLifecycleProvisioningStatus.Provisioned,
			provisionedAt: expect.any(String),
		});

		expect(admin.createTopics).toHaveBeenCalledWith({
			waitForLeaders: true,
			topics: [
				expect.objectContaining({
					topic: 'file.image.lifecycle.client.service-1.v1',
				}),
			],
		});
		expect(admin.createAcls).toHaveBeenCalledWith({
			acl: [
				{
					resourceType: AclResourceTypes.TOPIC,
					resourceName: 'file.image.lifecycle.client.service-1.v1',
					resourcePatternType: ResourcePatternTypes.LITERAL,
					principal: 'User:file-lifecycle-service-1',
					host: '*',
					operation: AclOperationTypes.READ,
					permissionType: AclPermissionTypes.ALLOW,
				},
				expect.objectContaining({ operation: AclOperationTypes.DESCRIBE }),
				expect.objectContaining({
					resourceType: AclResourceTypes.GROUP,
					resourceName: 'catalog-lifecycle',
					operation: AclOperationTypes.READ,
				}),
			],
		});
		expect(admin.disconnect).toHaveBeenCalled();
	});

	it('fails closed into FAILED provisioning state when Kafka rejects ACL creation', async () => {
		admin.createAcls.mockRejectedValue(new Error('authorizer rejected ACL'));
		const service = new KafkaLifecycleProvisionerService(() => admin);

		await expect(
			service.provision({
				clientServiceId: 'service-1',
				consumerGroup: 'catalog-lifecycle',
				subscriptionEnabled: true,
			}),
		).resolves.toMatchObject({
			provisioningStatus: ClientServiceLifecycleProvisioningStatus.Failed,
			provisioningError: 'authorizer rejected ACL',
			provisionedAt: null,
		});
	});

	it('returns PENDING without contacting Kafka when provisioning is disabled', async () => {
		process.env.LIFECYCLE_TOPIC_PROVISIONING_ENABLED = 'false';
		const service = new KafkaLifecycleProvisionerService(() => admin);

		await expect(
			service.provision({
				clientServiceId: 'service-1',
				consumerGroup: 'catalog-lifecycle',
				subscriptionEnabled: true,
			}),
		).resolves.toMatchObject({
			provisioningStatus: ClientServiceLifecycleProvisioningStatus.Pending,
		});
		expect(admin.connect).not.toHaveBeenCalled();
	});
});
