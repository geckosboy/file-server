import { Injectable } from '@nestjs/common';
import {
	ImageAssetSummary,
	ImageFormat,
	ImageTelemetryEvent,
	ImageVariantSummary,
	TelemetryMetrics,
} from './telemetry.types';

export interface TelemetryRepository {
	insertEvent(event: ImageTelemetryEvent): Promise<{ inserted: boolean }>;
	recordValidationFailure(): Promise<void>;
	recordInsertFailure(): Promise<void>;
	getMetrics(): Promise<TelemetryMetrics>;
	listEvents(): Promise<ImageTelemetryEvent[]>;
	listAssets(): Promise<ImageAssetSummary[]>;
	listVariants(imageKey?: string): Promise<ImageVariantSummary[]>;
	clear(): Promise<void>;
	getStorageKind(): 'memory' | 'postgresql';
	isConnected(): Promise<boolean>;
}

interface MutableImageAssetSummary extends ImageAssetSummary {
	durations: number[];
}

interface MutableImageVariantSummary extends ImageVariantSummary {
	durations: number[];
}

@Injectable()
export class InMemoryTelemetryRepository implements TelemetryRepository {
	private readonly eventsById = new Map<string, ImageTelemetryEvent>();
	private readonly assetsByKey = new Map<string, MutableImageAssetSummary>();
	private readonly variantsByKey = new Map<
		string,
		MutableImageVariantSummary
	>();
	private metrics: TelemetryMetrics = {
		validationFailureCount: 0,
		insertFailureCount: 0,
		lastConsumedEventAt: null,
	};

	async insertEvent(
		event: ImageTelemetryEvent,
	): Promise<{ inserted: boolean }> {
		if (this.eventsById.has(event.eventId)) {
			return { inserted: false };
		}

		this.eventsById.set(event.eventId, event);
		this.metrics = {
			...this.metrics,
			lastConsumedEventAt: event.receivedAt,
		};
		this.updateAsset(event);
		this.updateVariant(event);

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

	async getMetrics(): Promise<TelemetryMetrics> {
		return { ...this.metrics };
	}

	async listEvents(): Promise<ImageTelemetryEvent[]> {
		return [...this.eventsById.values()];
	}

	async listAssets(): Promise<ImageAssetSummary[]> {
		return [...this.assetsByKey.values()].map(
			({ durations: _durations, ...asset }) => ({
				...asset,
			}),
		);
	}

	async listVariants(imageKey?: string): Promise<ImageVariantSummary[]> {
		return [...this.variantsByKey.values()]
			.filter((variant) => !imageKey || variant.imageKey === imageKey)
			.map(({ durations: _durations, ...variant }) => ({
				...variant,
			}));
	}

	async clear(): Promise<void> {
		this.eventsById.clear();
		this.assetsByKey.clear();
		this.variantsByKey.clear();
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

	private updateAsset(event: ImageTelemetryEvent): void {
		const current = this.assetsByKey.get(event.imageKey);
		const next = current ?? {
			imageKey: event.imageKey,
			imageId: event.imageId,
			path: event.path,
			name: event.name,
			originalName: event.originalName,
			format: event.format,
			originalBytes: undefined,
			storedBytes: undefined,
			firstSeenAt: event.occurredAt,
			lastSeenAt: event.occurredAt,
			lastUploadedAt: undefined,
			lastReadAt: undefined,
			totalEvents: 0,
			totalReads: 0,
			totalResizes: 0,
			totalCacheHits: 0,
			totalCacheMisses: 0,
			totalFailures: 0,
			durations: [],
		};

		next.imageId = event.imageId ?? next.imageId;
		next.path = event.path;
		next.name = event.name;
		next.originalName = event.originalName ?? next.originalName;
		next.format = event.format ?? next.format;
		next.firstSeenAt = minIso(next.firstSeenAt, event.occurredAt);
		next.lastSeenAt = maxIso(next.lastSeenAt, event.occurredAt);
		next.totalEvents += 1;
		if (event.durationMs !== undefined) {
			next.durations.push(event.durationMs);
		}
		if (event.status === 'failed') {
			next.totalFailures += 1;
		}
		if (event.eventType === 'image.upload.completed') {
			next.lastUploadedAt = event.occurredAt;
			next.originalBytes = event.inputBytes ?? next.originalBytes;
			next.storedBytes = event.outputBytes ?? next.storedBytes;
		}
		if (event.eventType === 'image.resize.completed') {
			next.totalResizes += 1;
			next.storedBytes = event.outputBytes ?? next.storedBytes;
		}
		if (isReadEvent(event.eventType)) {
			next.totalReads += 1;
			next.lastReadAt = event.occurredAt;
		}
		if (event.eventType === 'image.cache.hit') {
			next.totalCacheHits += 1;
		}
		if (event.eventType === 'image.cache.miss') {
			next.totalCacheMisses += 1;
		}

		this.assetsByKey.set(event.imageKey, next);
	}

	private updateVariant(event: ImageTelemetryEvent): void {
		if (event.eventType !== 'image.resize.completed') {
			return;
		}

		const variantKey = createVariantKey(
			event.imageKey,
			event.width,
			event.height,
			event.format,
		);
		const current = this.variantsByKey.get(variantKey);
		const durations = current?.durations ?? [];
		if (event.durationMs !== undefined) {
			durations.push(event.durationMs);
		}

		this.variantsByKey.set(variantKey, {
			variantKey,
			imageKey: event.imageKey,
			width: event.width,
			height: event.height,
			format: event.format,
			outputBytes: event.outputBytes ?? current?.outputBytes,
			resizeCount: (current?.resizeCount ?? 0) + 1,
			avgDurationMs: average(durations),
			p95DurationMs: percentile(durations, 0.95),
			lastResizedAt: current?.lastResizedAt
				? maxIso(current.lastResizedAt, event.occurredAt)
				: event.occurredAt,
			durations,
		});
	}
}

export async function projectAssetSummaries(
	events: ImageTelemetryEvent[],
): Promise<ImageAssetSummary[]> {
	const repository = new InMemoryTelemetryRepository();
	for (const event of events) {
		await repository.insertEvent(event);
	}
	return repository.listAssets();
}

export async function projectVariantSummaries(
	events: ImageTelemetryEvent[],
	imageKey?: string,
): Promise<ImageVariantSummary[]> {
	const repository = new InMemoryTelemetryRepository();
	for (const event of events) {
		await repository.insertEvent(event);
	}
	return repository.listVariants(imageKey);
}

export function average(values: number[]): number | null {
	if (values.length === 0) {
		return null;
	}

	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function percentile(values: number[], quantile: number): number | null {
	if (values.length === 0) {
		return null;
	}

	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.ceil(sorted.length * quantile) - 1;
	return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function isReadEvent(eventType: string): boolean {
	return (
		eventType === 'image.cache.hit' ||
		eventType === 'image.cache.miss' ||
		eventType === 'image.read.completed' ||
		eventType === 'image.read.failed'
	);
}

function createVariantKey(
	imageKey: string,
	width: number | undefined,
	height: number | undefined,
	format: ImageFormat | undefined,
): string {
	return `${imageKey}:${width ?? 'auto'}x${height ?? 'auto'}:${format ?? 'unknown'}`;
}

function minIso(left: string, right: string): string {
	return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

function maxIso(left: string, right: string): string {
	return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}
