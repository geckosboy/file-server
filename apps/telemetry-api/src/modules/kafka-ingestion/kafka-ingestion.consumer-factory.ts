import { Injectable } from '@nestjs/common';
import { Consumer, Kafka, logLevel, Producer } from 'kafkajs';
import { readKafkaClientSecurityOptions } from '@file/nest-common';
import { TelemetryKafkaConsumerConfig } from './kafka-ingestion.config';

export type TelemetryKafkaConsumer = Pick<
	Consumer,
	'commitOffsets' | 'connect' | 'disconnect' | 'run' | 'subscribe'
>;

export type TelemetryKafkaDlqProducer = Pick<
	Producer,
	'connect' | 'disconnect' | 'send'
>;

export interface TelemetryKafkaConsumerFactory {
	create(config: TelemetryKafkaConsumerConfig): TelemetryKafkaConsumer;
	createDlqProducer(
		config: TelemetryKafkaConsumerConfig,
	): TelemetryKafkaDlqProducer;
}

export const TELEMETRY_KAFKA_CONSUMER_FACTORY = Symbol(
	'TELEMETRY_KAFKA_CONSUMER_FACTORY',
);

@Injectable()
export class KafkaJsTelemetryKafkaConsumerFactory implements TelemetryKafkaConsumerFactory {
	create(config: TelemetryKafkaConsumerConfig): TelemetryKafkaConsumer {
		const kafka = createKafkaClient(config);
		return kafka.consumer({ groupId: config.groupId });
	}

	createDlqProducer(
		config: TelemetryKafkaConsumerConfig,
	): TelemetryKafkaDlqProducer {
		return createKafkaClient(config).producer({
			allowAutoTopicCreation: false,
		});
	}
}

function createKafkaClient(config: TelemetryKafkaConsumerConfig): Kafka {
	return new Kafka({
		brokers: config.brokers,
		clientId: config.clientId,
		...readKafkaClientSecurityOptions(),
		logLevel: logLevel.WARN,
	});
}
