import { Global, Module } from '@nestjs/common';
import { LifecycleModule } from '../lifecycle/lifecycle.module';
import {
	KafkaJsLifecycleKafkaConsumerFactory,
	LIFECYCLE_KAFKA_CONSUMER_FACTORY,
} from './kafka-lifecycle.consumer-factory';
import { LifecycleKafkaConsumerService } from './kafka-lifecycle.service';
import { LifecycleKafkaConsumerStatusService } from './kafka-lifecycle.status';

@Global()
@Module({
	imports: [LifecycleModule],
	providers: [
		LifecycleKafkaConsumerStatusService,
		LifecycleKafkaConsumerService,
		{
			provide: LIFECYCLE_KAFKA_CONSUMER_FACTORY,
			useClass: KafkaJsLifecycleKafkaConsumerFactory,
		},
	],
	exports: [LifecycleKafkaConsumerStatusService],
})
export class KafkaLifecycleModule {}
