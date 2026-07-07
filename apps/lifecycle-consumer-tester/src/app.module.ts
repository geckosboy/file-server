import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ConsumerController } from './consumer/consumer.controller';
import { EventsController } from './consumer/events.controller';
import {
	KafkaJsLifecycleKafkaConsumerFactory,
	LIFECYCLE_KAFKA_CONSUMER_FACTORY,
} from './consumer/lifecycle-consumer.factory';
import { LifecycleConsumerService } from './consumer/lifecycle-consumer.service';
import { LifecycleConsumerStatusService } from './consumer/lifecycle-consumer-status.service';
import { LifecycleEventStoreService } from './consumer/lifecycle-event-store.service';

@Module({
	controllers: [HealthController, ConsumerController, EventsController],
	providers: [
		LifecycleConsumerService,
		LifecycleConsumerStatusService,
		LifecycleEventStoreService,
		{
			provide: LIFECYCLE_KAFKA_CONSUMER_FACTORY,
			useClass: KafkaJsLifecycleKafkaConsumerFactory,
		},
	],
})
export class AppModule {}
