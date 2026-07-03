import { Global, Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module';
import {
	KafkaJsTelemetryKafkaConsumerFactory,
	TELEMETRY_KAFKA_CONSUMER_FACTORY,
} from './kafka-ingestion.consumer-factory';
import { TelemetryKafkaConsumerService } from './kafka-ingestion.service';
import { TelemetryKafkaConsumerStatusService } from './kafka-ingestion.status';

@Global()
@Module({
	imports: [IngestionModule],
	providers: [
		TelemetryKafkaConsumerStatusService,
		TelemetryKafkaConsumerService,
		{
			provide: TELEMETRY_KAFKA_CONSUMER_FACTORY,
			useClass: KafkaJsTelemetryKafkaConsumerFactory,
		},
	],
	exports: [TelemetryKafkaConsumerStatusService],
})
export class KafkaIngestionModule {}
