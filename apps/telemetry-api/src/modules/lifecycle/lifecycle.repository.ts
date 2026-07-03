import { Injectable } from '@nestjs/common';
import { ImageLifecycleEvent, LifecycleMetrics } from './lifecycle.types';

export interface LifecycleRepository {
	insertEvent(event: ImageLifecycleEvent): Promise<{ inserted: boolean }>;
	recordValidationFailure(): Promise<void>;
	recordInsertFailure(): Promise<void>;
	getMetrics(): Promise<LifecycleMetrics>;
	listEvents(): Promise<ImageLifecycleEvent[]>;
	clear(): Promise<void>;
	getStorageKind(): 'memory' | 'postgresql';
	isConnected(): Promise<boolean>;
}

@Injectable()
export class InMemoryLifecycleRepository implements LifecycleRepository {
	private readonly eventsById = new Map<string, ImageLifecycleEvent>();
	private metrics: LifecycleMetrics = {
		validationFailureCount: 0,
		insertFailureCount: 0,
		lastConsumedEventAt: null,
	};

	async insertEvent(
		event: ImageLifecycleEvent,
	): Promise<{ inserted: boolean }> {
		if (this.eventsById.has(event.eventId)) {
			return { inserted: false };
		}

		this.eventsById.set(event.eventId, event);
		this.metrics = {
			...this.metrics,
			lastConsumedEventAt: event.receivedAt,
		};
		return { inserted: true };
	}

	async recordValidationFailure(): Promise<void> {
		this.metrics = {
			...this.metrics,
			validationFailureCount: this.metrics.validationFailureCount + 1,
		};
	}

	async recordInsertFailure(): Promise<void> {
		this.metrics = {
			...this.metrics,
			insertFailureCount: this.metrics.insertFailureCount + 1,
		};
	}

	async getMetrics(): Promise<LifecycleMetrics> {
		return { ...this.metrics };
	}

	async listEvents(): Promise<ImageLifecycleEvent[]> {
		return [...this.eventsById.values()];
	}

	async clear(): Promise<void> {
		this.eventsById.clear();
		this.metrics = {
			validationFailureCount: 0,
			insertFailureCount: 0,
			lastConsumedEventAt: null,
		};
	}

	getStorageKind(): 'memory' {
		return 'memory';
	}

	async isConnected(): Promise<boolean> {
		return true;
	}
}
