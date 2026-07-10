import { Injectable } from '@nestjs/common';
import { Consumer, Kafka, logLevel, Producer } from 'kafkajs';
import { readKafkaClientSecurityOptions } from '@file/nest-common';
import { LifecycleKafkaConsumerConfig } from './kafka-lifecycle.config';

export type LifecycleKafkaConsumer = Pick<
	Consumer,
	'commitOffsets' | 'connect' | 'disconnect' | 'run' | 'subscribe'
>;

export type LifecycleKafkaDlqProducer = Pick<
	Producer,
	'connect' | 'disconnect' | 'send'
>;

export interface LifecycleKafkaConsumerFactory {
	create(config: LifecycleKafkaConsumerConfig): LifecycleKafkaConsumer;
	createDlqProducer(
		config: LifecycleKafkaConsumerConfig,
	): LifecycleKafkaDlqProducer;
}

export const LIFECYCLE_KAFKA_CONSUMER_FACTORY = Symbol(
	'LIFECYCLE_KAFKA_CONSUMER_FACTORY',
);

@Injectable()
export class KafkaJsLifecycleKafkaConsumerFactory implements LifecycleKafkaConsumerFactory {
	create(config: LifecycleKafkaConsumerConfig): LifecycleKafkaConsumer {
		const kafka = createKafkaClient(config);
		return kafka.consumer({ groupId: config.groupId });
	}

	createDlqProducer(
		config: LifecycleKafkaConsumerConfig,
	): LifecycleKafkaDlqProducer {
		return createKafkaClient(config).producer({
			allowAutoTopicCreation: false,
		});
	}
}

function createKafkaClient(config: LifecycleKafkaConsumerConfig): Kafka {
	return new Kafka({
		brokers: config.brokers,
		clientId: config.clientId,
		...readKafkaClientSecurityOptions(),
		logLevel: logLevel.WARN,
	});
}
