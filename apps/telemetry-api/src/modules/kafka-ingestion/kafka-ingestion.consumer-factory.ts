import { Injectable } from '@nestjs/common';
import { Consumer, Kafka, logLevel } from 'kafkajs';
import { TelemetryKafkaConsumerConfig } from './kafka-ingestion.config';

export type TelemetryKafkaConsumer = Pick<
	Consumer,
	'connect' | 'disconnect' | 'run' | 'subscribe'
>;

export interface TelemetryKafkaConsumerFactory {
	create(config: TelemetryKafkaConsumerConfig): TelemetryKafkaConsumer;
}

export const TELEMETRY_KAFKA_CONSUMER_FACTORY = Symbol(
	'TELEMETRY_KAFKA_CONSUMER_FACTORY',
);

@Injectable()
export class KafkaJsTelemetryKafkaConsumerFactory implements TelemetryKafkaConsumerFactory {
	create(config: TelemetryKafkaConsumerConfig): TelemetryKafkaConsumer {
		const kafka = new Kafka({
			brokers: config.brokers,
			clientId: config.clientId,
			logLevel: logLevel.WARN,
		});

		return kafka.consumer({ groupId: config.groupId });
	}
}
