import {
	IMAGE_TELEMETRY_TOPIC,
	ImageTelemetryEvent,
	createTelemetryKafkaKey,
	deliverImageTelemetryEvent,
} from '@file/telemetry-contracts/events';
import { Logger } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';

export * from '@file/telemetry-contracts/events';

export const publishImageTelemetryEvent = ({
	client,
	event,
	logger,
}: {
	client?: Pick<ClientKafka, 'emit'>;
	event: ImageTelemetryEvent;
	logger: Logger;
}) =>
	deliverImageTelemetryEvent({
		event,
		deliver:
			client && typeof client.emit === 'function'
				? (validatedEvent) =>
						lastValueFrom(
							client.emit(IMAGE_TELEMETRY_TOPIC, {
								key: createTelemetryKafkaKey(validatedEvent),
								value: JSON.stringify(validatedEvent),
							}),
						)
				: undefined,
		onFailure: ({ errorMessage, failureCount }) =>
			logger.warn(
				`이미지 텔레메트리 이벤트 발행 실패: ${errorMessage} image_telemetry_delivery_failures_total=${failureCount}`,
			),
	});
