import { Injectable } from '@nestjs/common';
import { ImageLifecycleEvent } from '@file/telemetry-contracts/lifecycle';
import { readLifecycleConsumerTesterConfig } from '../config/lifecycle-consumer-tester.config';

export interface ReceivedLifecycleEventRecord {
	receivedAt: string;
	topic: string;
	partition: number;
	offset: string;
	key: string | null;
	event: ImageLifecycleEvent;
}

export interface LifecycleEventQuery {
	limit?: number | string;
	eventType?: string;
	status?: string;
	clientServiceId?: string;
	clientServiceSlug?: string;
	imageKey?: string;
}

@Injectable()
export class LifecycleEventStoreService {
	private readonly maxStoredEvents =
		readLifecycleConsumerTesterConfig().maxStoredEvents;
	private records: ReceivedLifecycleEventRecord[] = [];

	add(record: ReceivedLifecycleEventRecord) {
		this.records.unshift(record);
		if (this.records.length > this.maxStoredEvents) {
			this.records.splice(this.maxStoredEvents);
		}
	}

	list(query: LifecycleEventQuery = {}) {
		const limit = parseLimit(query.limit);
		return this.records
			.filter((record) => matchesQuery(record, query))
			.slice(0, limit)
			.map(cloneRecord);
	}

	clear() {
		const deleted = this.records.length;
		this.records = [];
		return deleted;
	}

	count() {
		return this.records.length;
	}
}

function matchesQuery(
	record: ReceivedLifecycleEventRecord,
	query: LifecycleEventQuery,
) {
	return (
		matchesOptional(record.event.eventType, query.eventType) &&
		matchesOptional(record.event.status, query.status) &&
		matchesOptional(record.event.clientServiceId, query.clientServiceId) &&
		matchesOptional(record.event.clientServiceSlug, query.clientServiceSlug) &&
		matchesOptional(record.event.imageKey, query.imageKey)
	);
}

function matchesOptional(
	actual: string | undefined,
	expected: string | undefined,
) {
	return expected === undefined || expected === '' || actual === expected;
}

function parseLimit(value: number | string | undefined) {
	if (value === undefined) {
		return 50;
	}
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : 50;
}

function cloneRecord(record: ReceivedLifecycleEventRecord) {
	return {
		...record,
		event: { ...record.event },
	};
}
