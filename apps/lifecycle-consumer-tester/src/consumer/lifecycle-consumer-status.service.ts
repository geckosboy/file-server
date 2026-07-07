import { Injectable } from '@nestjs/common';
import { LifecycleConsumerTesterConfig } from '../config/lifecycle-consumer-tester.config';

export interface LifecycleConsumerTesterStatus {
	enabled: boolean;
	connected: boolean;
	consumerLag: null;
	brokers: string[];
	clientId: string;
	groupId: string;
	topic: string;
	fromBeginning: boolean;
	allowedEventTypes: string[];
	filters: {
		clientServiceId: string | null;
		clientServiceSlug: string | null;
	};
	storedEventCount: number;
	receivedEventCount: number;
	skippedEventCount: number;
	invalidMessageCount: number;
	lastConsumedAt: string | null;
	lastStoredAt: string | null;
	lastError: string | null;
	disabledReason?: string;
}

@Injectable()
export class LifecycleConsumerStatusService {
	private status: LifecycleConsumerTesterStatus = {
		enabled: false,
		connected: false,
		consumerLag: null,
		brokers: [],
		clientId: 'lifecycle-consumer-tester',
		groupId: 'lifecycle-consumer-tester-local',
		topic: 'file.image.lifecycle.v1',
		fromBeginning: true,
		allowedEventTypes: [],
		filters: {
			clientServiceId: null,
			clientServiceSlug: null,
		},
		storedEventCount: 0,
		receivedEventCount: 0,
		skippedEventCount: 0,
		invalidMessageCount: 0,
		lastConsumedAt: null,
		lastStoredAt: null,
		lastError: null,
		disabledReason: 'Lifecycle consumer tester가 아직 초기화되지 않았습니다.',
	};

	configure(config: LifecycleConsumerTesterConfig) {
		this.status = {
			...this.status,
			enabled: config.enabled,
			connected: false,
			brokers: [...config.brokers],
			clientId: config.clientId,
			groupId: config.groupId,
			topic: config.topic,
			fromBeginning: config.fromBeginning,
			allowedEventTypes: [...config.allowedEventTypes],
			filters: {
				clientServiceId: config.clientServiceId ?? null,
				clientServiceSlug: config.clientServiceSlug ?? null,
			},
			lastError: null,
			disabledReason: config.disabledReason,
		};
	}

	markConnected() {
		this.status = {
			...this.status,
			connected: true,
			lastError: null,
			disabledReason: undefined,
		};
	}

	markDisconnected(error?: unknown) {
		this.status = {
			...this.status,
			connected: false,
			lastError: error ? errorToMessage(error) : null,
		};
	}

	markReceived() {
		this.status = {
			...this.status,
			receivedEventCount: this.status.receivedEventCount + 1,
			lastConsumedAt: new Date().toISOString(),
		};
	}

	markStored(storedEventCount: number) {
		this.status = {
			...this.status,
			storedEventCount,
			lastStoredAt: new Date().toISOString(),
		};
	}

	markSkipped() {
		this.status = {
			...this.status,
			skippedEventCount: this.status.skippedEventCount + 1,
		};
	}

	markInvalid(error: unknown) {
		this.status = {
			...this.status,
			invalidMessageCount: this.status.invalidMessageCount + 1,
			lastConsumedAt: new Date().toISOString(),
			lastError: errorToMessage(error),
		};
	}

	markCleared() {
		this.status = {
			...this.status,
			storedEventCount: 0,
		};
	}

	getStatus(): LifecycleConsumerTesterStatus {
		return {
			...this.status,
			brokers: [...this.status.brokers],
			allowedEventTypes: [...this.status.allowedEventTypes],
			filters: { ...this.status.filters },
		};
	}
}

function errorToMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
