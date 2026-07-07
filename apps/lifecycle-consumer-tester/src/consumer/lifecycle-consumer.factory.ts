import { Injectable } from '@nestjs/common';
import { Consumer, Kafka, logLevel } from 'kafkajs';
import { LifecycleConsumerTesterConfig } from '../config/lifecycle-consumer-tester.config';

export type LifecycleKafkaConsumer = Pick<
	Consumer,
	'connect' | 'disconnect' | 'run' | 'subscribe'
>;

export interface LifecycleKafkaConsumerFactory {
	create(config: LifecycleConsumerTesterConfig): LifecycleKafkaConsumer;
}

export const LIFECYCLE_KAFKA_CONSUMER_FACTORY = Symbol(
	'LIFECYCLE_KAFKA_CONSUMER_FACTORY',
);

@Injectable()
export class KafkaJsLifecycleKafkaConsumerFactory implements LifecycleKafkaConsumerFactory {
	create(config: LifecycleConsumerTesterConfig): LifecycleKafkaConsumer {
		const kafka = new Kafka({
			brokers: config.brokers,
			clientId: config.clientId,
			logLevel: logLevel.WARN,
		});

		return kafka.consumer({ groupId: config.groupId });
	}
}
