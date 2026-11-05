import {
	Inject,
	Injectable,
	Logger,
	OnApplicationBootstrap,
	OnApplicationShutdown,
} from '@nestjs/common';
import { EachMessagePayload } from 'kafkajs';
import { validateImageLifecycleEvent } from '@file/telemetry-contracts/lifecycle';
import { readLifecycleConsumerTesterConfig } from '../config/lifecycle-consumer-tester.config';
import { parseKafkaMessageValue } from './kafka-message.parser';
import {
	LIFECYCLE_KAFKA_CONSUMER_FACTORY,
	LifecycleKafkaConsumer,
	LifecycleKafkaConsumerFactory,
} from './lifecycle-consumer.factory';
import { LifecycleEventStoreService } from './lifecycle-event-store.service';
import { LifecycleConsumerStatusService } from './lifecycle-consumer-status.service';

@Injectable()
export class LifecycleConsumerService
	implements OnApplicationBootstrap, OnApplicationShutdown
{
	private readonly logger = new Logger(LifecycleConsumerService.name);
	private consumer?: LifecycleKafkaConsumer;
	private readonly config = readLifecycleConsumerTesterConfig();

	constructor(
		private readonly eventStore: LifecycleEventStoreService,
		private readonly statusService: LifecycleConsumerStatusService,
		@Inject(LIFECYCLE_KAFKA_CONSUMER_FACTORY)
		private readonly consumerFactory: LifecycleKafkaConsumerFactory,
	) {}

	async onApplicationBootstrap() {
		this.statusService.configure(this.config);
		if (!this.config.enabled) {
			this.logger.log(
				`Lifecycle consumer tester disabled: ${this.config.disabledReason}`,
			);
			return;
		}

		try {
			this.consumer = this.consumerFactory.create(this.config);
			await this.consumer.connect();
			await this.consumer.subscribe({
				topic: this.config.topic,
				fromBeginning: this.config.fromBeginning,
			});
			await this.consumer.run({
				eachMessage: (payload) => this.handleMessage(payload),
			});
			this.statusService.markConnected();
			this.logger.log(
				`Lifecycle consumer tester connected: ${this.config.topic} group=${this.config.groupId}`,
			);
		} catch (error) {
			this.statusService.markDisconnected(error);
			this.logger.error(
				`Lifecycle consumer tester 연결 실패: ${errorToMessage(error)}`,
			);
		}
	}

	async onApplicationShutdown() {
		if (!this.consumer) {
			return;
		}

		try {
			await this.consumer.disconnect();
		} finally {
			this.statusService.markDisconnected();
		}
	}

	async handleMessage(payload: EachMessagePayload): Promise<void> {
		this.statusService.markReceived();

		const parsed = parseKafkaMessageValue(payload.message.value);
		if (!parsed.ok) {
			this.statusService.markInvalid(parsed.reason);
			this.logger.warn(`Lifecycle message 파싱 실패: ${parsed.reason}`);
			return;
		}

		const validated = validateImageLifecycleEvent(parsed.payload);
		if (!validated.ok) {
			const reason = validated.errors.join(', ');
			this.statusService.markInvalid(reason);
			this.logger.warn(`Lifecycle message 검증 실패: ${reason}`);
			return;
		}

		if (!this.shouldStore(validated.event)) {
			this.statusService.markSkipped();
			this.logger.log(
				`Lifecycle event skipped by filter: ${formatLifecycleEventLog(validated.event)}`,
			);
			return;
		}

		this.eventStore.add({
			receivedAt: new Date().toISOString(),
			topic: payload.topic,
			partition: payload.partition,
			offset: payload.message.offset,
			key: payload.message.key?.toString('utf8') ?? null,
			event: validated.event,
		});
		this.statusService.markStored(this.eventStore.count());
		this.logger.log(
			`Lifecycle event stored: ${formatLifecycleEventLog(validated.event)} offset=${payload.partition}:${payload.message.offset}`,
		);
	}

	private shouldStore(event: {
		eventType: string;
		clientServiceId?: string;
		clientServiceSlug?: string;
	}) {
		return (
			this.config.allowedEventTypes.includes(event.eventType) &&
			matchesOptionalFilter(
				event.clientServiceId,
				this.config.clientServiceId,
			) &&
			matchesOptionalFilter(
				event.clientServiceSlug,
				this.config.clientServiceSlug,
			)
		);
	}
}

function matchesOptionalFilter(actual: string | undefined, expected?: string) {
	return expected === undefined || actual === expected;
}

function errorToMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatLifecycleEventLog(event: {
	eventId: string;
	eventType: string;
	status: string;
	clientServiceSlug?: string;
	clientServiceId?: string;
	imageKey: string;
}) {
	return [
		`eventId=${event.eventId}`,
		`eventType=${event.eventType}`,
		`status=${event.status}`,
		`clientService=${event.clientServiceSlug ?? event.clientServiceId ?? 'unknown'}`,
		`imageKey=${event.imageKey}`,
	].join(' ');
}
