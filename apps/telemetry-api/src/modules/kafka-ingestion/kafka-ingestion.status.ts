import { Injectable } from '@nestjs/common';
import { TelemetryKafkaConsumerConfig } from './kafka-ingestion.config';
import {
	KafkaLagSnapshot,
	KafkaPartitionLag,
} from '../kafka/kafka-consumer-lag';

export interface TelemetryKafkaConsumerHealth {
	enabled: boolean;
	connected: boolean;
	brokerConnected: boolean;
	ready: boolean;
	consumerLag: number | null;
	partitionLag: KafkaPartitionLag[];
	brokers: string[];
	clientId: string;
	groupId: string;
	topic: string;
	lastConsumedAt: string | null;
	lastError: string | null;
	lastLagError: string | null;
	lagCheckedAt: string | null;
	reconnectAttempts: number;
	nextReconnectAt: string | null;
	dlqCount: number;
	disabledReason?: string;
}

@Injectable()
export class TelemetryKafkaConsumerStatusService {
	private health: TelemetryKafkaConsumerHealth = {
		enabled: false,
		connected: false,
		brokerConnected: false,
		ready: true,
		consumerLag: null,
		partitionLag: [],
		brokers: [],
		clientId: 'telemetry-api',
		groupId: 'file-telemetry-api',
		topic: 'file.image.events.v1',
		lastConsumedAt: null,
		lastError: null,
		lastLagError: null,
		lagCheckedAt: null,
		reconnectAttempts: 0,
		nextReconnectAt: null,
		dlqCount: 0,
		disabledReason: 'Kafka consumer가 아직 초기화되지 않았습니다.',
	};

	configure(config: TelemetryKafkaConsumerConfig) {
		this.health = {
			...this.health,
			enabled: config.enabled,
			connected: false,
			brokerConnected: false,
			ready: !config.enabled,
			consumerLag: null,
			partitionLag: [],
			brokers: config.brokers,
			clientId: config.clientId,
			groupId: config.groupId,
			topic: config.topic,
			disabledReason: config.disabledReason,
			lastError: null,
			lastLagError: null,
			lagCheckedAt: null,
			reconnectAttempts: 0,
			nextReconnectAt: null,
		};
	}

	markConnected() {
		this.health = {
			...this.health,
			connected: true,
			ready: this.health.brokerConnected,
			lastError: null,
			reconnectAttempts: 0,
			nextReconnectAt: null,
			disabledReason: undefined,
		};
	}

	markConsumerInactive(error?: unknown) {
		this.health = {
			...this.health,
			connected: false,
			ready: !this.health.enabled,
			lastError:
				error === undefined ? this.health.lastError : errorToMessage(error),
		};
	}

	markDisconnected(error?: unknown) {
		this.health = {
			...this.health,
			connected: false,
			brokerConnected: false,
			ready: !this.health.enabled,
			consumerLag: null,
			partitionLag: [],
			lagCheckedAt: null,
			lastError: error ? errorToMessage(error) : null,
		};
	}

	markReconnectScheduled(attempt: number, delayMs: number) {
		this.health = {
			...this.health,
			reconnectAttempts: attempt,
			nextReconnectAt: new Date(Date.now() + delayMs).toISOString(),
		};
	}

	markLag(snapshot: KafkaLagSnapshot) {
		this.health = {
			...this.health,
			brokerConnected: true,
			ready: this.health.connected,
			consumerLag: snapshot.consumerLag,
			partitionLag: snapshot.partitions,
			lagCheckedAt: snapshot.checkedAt,
			lastLagError: null,
		};
	}

	markLagUnavailable(error: unknown) {
		this.health = {
			...this.health,
			brokerConnected: false,
			ready: !this.health.enabled,
			consumerLag: null,
			partitionLag: [],
			lastLagError: errorToMessage(error),
		};
	}

	markDeadLettered() {
		this.health = { ...this.health, dlqCount: this.health.dlqCount + 1 };
	}

	markConsumed() {
		this.health = {
			...this.health,
			lastConsumedAt: new Date().toISOString(),
		};
	}

	getHealth(): TelemetryKafkaConsumerHealth {
		return {
			...this.health,
			brokers: [...this.health.brokers],
			partitionLag: this.health.partitionLag.map((item) => ({ ...item })),
		};
	}
}

function errorToMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
