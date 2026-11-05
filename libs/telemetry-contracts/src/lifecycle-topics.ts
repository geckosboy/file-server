import { IMAGE_LIFECYCLE_TOPIC } from './lifecycle';

export const IMAGE_LIFECYCLE_CLIENT_TOPIC_PREFIX =
	'file.image.lifecycle.client' as const;
export const IMAGE_LIFECYCLE_CLIENT_TOPIC_VERSION = 'v1' as const;

const CLIENT_SERVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const createClientLifecycleTopic = (clientServiceId: string): string => {
	const normalizedClientServiceId = clientServiceId.trim().toLowerCase();
	if (!CLIENT_SERVICE_ID_PATTERN.test(normalizedClientServiceId)) {
		throw new Error('clientServiceId cannot be converted to a Kafka topic');
	}

	return `${IMAGE_LIFECYCLE_CLIENT_TOPIC_PREFIX}.${normalizedClientServiceId}.${IMAGE_LIFECYCLE_CLIENT_TOPIC_VERSION}`;
};

export const createClientLifecyclePrincipal = (
	clientServiceId: string,
): string => {
	const topic = createClientLifecycleTopic(clientServiceId);
	const normalizedClientServiceId = topic.slice(
		IMAGE_LIFECYCLE_CLIENT_TOPIC_PREFIX.length + 1,
		-(IMAGE_LIFECYCLE_CLIENT_TOPIC_VERSION.length + 1),
	);
	return `User:file-lifecycle-${normalizedClientServiceId}`;
};

export const isCanonicalLifecycleTopic = (topic: string): boolean =>
	topic === IMAGE_LIFECYCLE_TOPIC;
