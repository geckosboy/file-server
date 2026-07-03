import {
	ImageLifecycleEvent as ContractImageLifecycleEvent,
	ImageLifecycleEventType,
	ImageLifecycleFormat,
	ImageLifecycleStatus,
} from '@file/telemetry-contracts/lifecycle';
import {
	TelemetryMetrics,
	TelemetryRange,
	UnknownRecord,
} from '../telemetry/telemetry.types';

export const IMAGE_LIFECYCLE_TOPIC = 'file.image.lifecycle.v1' as const;

export type ImageLifecycleEvent = ContractImageLifecycleEvent & {
	receivedAt: string;
	rawPayload: UnknownRecord;
};

export type StoredImageLifecycleEventType = ImageLifecycleEventType;
export type StoredImageLifecycleStatus = ImageLifecycleStatus;
export type StoredImageLifecycleFormat = ImageLifecycleFormat;

export type LifecycleMetrics = TelemetryMetrics;

export interface LifecycleEventFilter extends Partial<TelemetryRange> {
	eventType?: string;
	status?: string;
	clientServiceId?: string;
	clientServiceSlug?: string;
	path?: string;
	name?: string;
	imageKey?: string;
	requestId?: string;
	cursor?: string;
	limit?: number;
}
