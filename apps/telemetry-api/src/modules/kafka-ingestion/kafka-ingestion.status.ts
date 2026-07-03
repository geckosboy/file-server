import { Injectable } from '@nestjs/common';
import { TelemetryKafkaConsumerConfig } from './kafka-ingestion.config';

export interface TelemetryKafkaConsumerHealth {
	enabled: boolean;
	connected: boolean;
	consumerLag: null;
	brokers: string[];
	clientId: string;
	groupId: string;
	topic: string;
	lastConsumedAt: string | null;
	lastError: string | null;
	disabledReason?: string;
}

@Injectable()
export class TelemetryKafkaConsumerStatusService {
	private health: TelemetryKafkaConsumerHealth = {
		enabled: false,
		connected: false,
		consumerLag: null,
		brokers: [],
		clientId: 'telemetry-api',
		groupId: 'file-telemetry-api',
		topic: 'file.image.events.v1',
		lastConsumedAt: null,
		lastError: null,
		disabledReason: 'Kafka consumer가 아직 초기화되지 않았습니다.',
	};

	configure(config: TelemetryKafkaConsumerConfig) {
		this.health = {
			...this.health,
			enabled: config.enabled,
			connected: false,
			brokers: config.brokers,
			clientId: config.clientId,
			groupId: config.groupId,
			topic: config.topic,
			disabledReason: config.disabledReason,
			lastError: null,
		};
	}

	markConnected() {
		this.health = {
			...this.health,
			connected: true,
			lastError: null,
			disabledReason: undefined,
		};
	}

	markDisconnected(error?: unknown) {
		this.health = {
			...this.health,
			connected: false,
			lastError: error ? errorToMessage(error) : null,
		};
	}

	markConsumed() {
		this.health = {
			...this.health,
			lastConsumedAt: new Date().toISOString(),
		};
	}

	getHealth(): TelemetryKafkaConsumerHealth {
		return { ...this.health, brokers: [...this.health.brokers] };
	}
}

function errorToMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
