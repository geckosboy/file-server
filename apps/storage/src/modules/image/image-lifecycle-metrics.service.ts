import { Injectable } from '@nestjs/common';

export interface ImageLifecycleMetricsSnapshot {
	variantJobs: {
		enabled: boolean;
		connected: boolean;
		ready: boolean;
		inFlight: number;
		enqueuedTotal: number;
		publishedTotal: number;
		publishFailedTotal: number;
		completedTotal: number;
		failedTotal: number;
		duplicateTotal: number;
		oldestQueuedAgeMs: number | null;
		lastCompletedAt: string | null;
		lastError: string | null;
	};
	cacheInvalidationPublisher: {
		attemptedTotal: number;
		publishedTotal: number;
		failedTotal: number;
		lastPublishedAt: string | null;
		lastError: string | null;
	};
	assetDeletes: {
		completedTotal: number;
		failedTotal: number;
		lastEventId: string | null;
		lastError: string | null;
	};
}

@Injectable()
export class ImageLifecycleMetricsService {
	private queued = 0;
	private variantWorkerEnabled = false;
	private variantWorkerConnected = false;
	private inFlight = 0;
	private enqueuedTotal = 0;
	private publishedTotal = 0;
	private publishFailedTotal = 0;
	private completedTotal = 0;
	private failedTotal = 0;
	private duplicateTotal = 0;
	private oldestQueuedAt?: number;
	private lastCompletedAt?: string;
	private variantLastError?: string;
	private invalidationAttemptedTotal = 0;
	private invalidationPublishedTotal = 0;
	private invalidationFailedTotal = 0;
	private invalidationLastPublishedAt?: string;
	private invalidationLastError?: string;
	private deleteCompletedTotal = 0;
	private deleteFailedTotal = 0;
	private deleteLastEventId?: string;
	private deleteLastError?: string;

	recordVariantEnqueued(queueDepth: number): void {
		this.queued = queueDepth;
		this.enqueuedTotal = increment(this.enqueuedTotal);
		this.oldestQueuedAt ??= Date.now();
	}

	setVariantWorkerStatus(enabled: boolean, connected: boolean): void {
		this.variantWorkerEnabled = enabled;
		this.variantWorkerConnected = connected;
	}

	recordVariantPublished(): void {
		this.publishedTotal = increment(this.publishedTotal);
	}

	recordVariantPublishFailed(error: unknown): void {
		this.publishFailedTotal = increment(this.publishFailedTotal);
		this.variantLastError = errorMessage(error);
	}

	recordVariantDequeued(queueDepth: number, inFlight: number): void {
		this.queued = queueDepth;
		this.inFlight = inFlight;
		if (queueDepth === 0) this.oldestQueuedAt = undefined;
	}

	recordVariantCompleted(inFlight: number): void {
		this.inFlight = inFlight;
		this.completedTotal = increment(this.completedTotal);
		this.lastCompletedAt = new Date().toISOString();
		this.variantLastError = undefined;
	}

	recordVariantFailed(error: unknown, inFlight: number): void {
		this.inFlight = inFlight;
		this.failedTotal = increment(this.failedTotal);
		this.variantLastError = errorMessage(error);
	}

	recordVariantDuplicate(): void {
		this.duplicateTotal = increment(this.duplicateTotal);
	}

	recordInvalidationAttempt(): void {
		this.invalidationAttemptedTotal = increment(
			this.invalidationAttemptedTotal,
		);
	}

	recordInvalidationPublished(): void {
		this.invalidationPublishedTotal = increment(
			this.invalidationPublishedTotal,
		);
		this.invalidationLastPublishedAt = new Date().toISOString();
		this.invalidationLastError = undefined;
	}

	recordInvalidationFailed(error: unknown): void {
		this.invalidationFailedTotal = increment(this.invalidationFailedTotal);
		this.invalidationLastError = errorMessage(error);
	}

	recordDeleteCompleted(eventId?: string): void {
		this.deleteCompletedTotal = increment(this.deleteCompletedTotal);
		this.deleteLastEventId = eventId;
		this.deleteLastError = undefined;
	}

	recordDeleteFailed(eventId: string | undefined, error: unknown): void {
		this.deleteFailedTotal = increment(this.deleteFailedTotal);
		this.deleteLastEventId = eventId;
		this.deleteLastError = errorMessage(error);
	}

	getMetrics(): ImageLifecycleMetricsSnapshot {
		return {
			variantJobs: {
				enabled: this.variantWorkerEnabled,
				connected: this.variantWorkerConnected,
				ready: !this.variantWorkerEnabled || this.variantWorkerConnected,
				inFlight: this.inFlight,
				enqueuedTotal: this.enqueuedTotal,
				publishedTotal: this.publishedTotal,
				publishFailedTotal: this.publishFailedTotal,
				completedTotal: this.completedTotal,
				failedTotal: this.failedTotal,
				duplicateTotal: this.duplicateTotal,
				oldestQueuedAgeMs: this.oldestQueuedAt
					? Math.max(0, Date.now() - this.oldestQueuedAt)
					: null,
				lastCompletedAt: this.lastCompletedAt ?? null,
				lastError: this.variantLastError ?? null,
			},
			cacheInvalidationPublisher: {
				attemptedTotal: this.invalidationAttemptedTotal,
				publishedTotal: this.invalidationPublishedTotal,
				failedTotal: this.invalidationFailedTotal,
				lastPublishedAt: this.invalidationLastPublishedAt ?? null,
				lastError: this.invalidationLastError ?? null,
			},
			assetDeletes: {
				completedTotal: this.deleteCompletedTotal,
				failedTotal: this.deleteFailedTotal,
				lastEventId: this.deleteLastEventId ?? null,
				lastError: this.deleteLastError ?? null,
			},
		};
	}
}

function increment(value: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
