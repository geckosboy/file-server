import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from './admin-auth.guard';
import {
	AdminQueryService,
	ImageResizeRecommendationQuery,
} from './admin-query.service';
import { LifecycleEventFilter } from '../lifecycle/lifecycle.types';
import {
	EventFilter,
	ImageFilter,
	TimeseriesQuery,
} from '../telemetry/telemetry.types';

@UseGuards(AdminAuthGuard)
@Controller('api/admin')
export class AdminController {
	constructor(private readonly queryService: AdminQueryService) {}

	@Get('health')
	getHealth() {
		return this.queryService.getHealth();
	}

	@Get('dashboard/summary')
	getSummary(@Query() query: Partial<EventFilter>) {
		return this.queryService.getSummary(query);
	}

	@Get('dashboard/timeseries')
	getTimeseries(@Query() query: TimeseriesQuery) {
		return this.queryService.getTimeseries(query);
	}

	@Get('events')
	listEvents(@Query() query: EventFilter) {
		return this.queryService.listEvents(normalizeEventQuery(query));
	}

	@Get('lifecycle-events')
	listLifecycleEvents(@Query() query: LifecycleEventFilter) {
		return this.queryService.listLifecycleEvents(
			normalizeLifecycleEventQuery(query),
		);
	}

	@Get('images')
	listImages(@Query() query: ImageFilter) {
		return this.queryService.listImages(normalizeImageQuery(query));
	}

	@Get('image-resize-recommendations')
	listImageResizeRecommendations(
		@Query() query: ImageResizeRecommendationQuery,
	) {
		return this.queryService.listImageResizeRecommendations(
			normalizeImageResizeRecommendationQuery(query),
		);
	}

	@Get('images/:imageKey')
	getImage(@Param('imageKey') imageKey: string) {
		return this.queryService.getImage(imageKey);
	}

	@Get('images/:imageKey/events')
	listImageEvents(
		@Param('imageKey') imageKey: string,
		@Query() query: EventFilter,
	) {
		return this.queryService.listImageEvents(
			imageKey,
			normalizeEventQuery(query),
		);
	}

	@Get('images/:imageKey/lifecycle-events')
	listImageLifecycleEvents(
		@Param('imageKey') imageKey: string,
		@Query() query: LifecycleEventFilter,
	) {
		return this.queryService.listImageLifecycleEvents(
			imageKey,
			normalizeLifecycleEventQuery(query),
		);
	}

	@Get('images/:imageKey/variants')
	listImageVariants(@Param('imageKey') imageKey: string) {
		return this.queryService.listImageVariants(imageKey);
	}
}

function normalizeEventQuery(query: EventFilter): EventFilter {
	return {
		...query,
		limit: normalizeNumber(query.limit),
	};
}

function normalizeLifecycleEventQuery(
	query: LifecycleEventFilter,
): LifecycleEventFilter {
	return {
		...query,
		limit: normalizeNumber(query.limit),
	};
}

function normalizeImageQuery(query: ImageFilter): ImageFilter {
	return {
		...query,
		limit: normalizeNumber(query.limit),
	};
}

function normalizeImageResizeRecommendationQuery(
	query: ImageResizeRecommendationQuery,
): ImageResizeRecommendationQuery {
	return {
		...query,
		limit: normalizeNumber(query.limit),
		minRequests: normalizeNumber(query.minRequests),
	};
}

function normalizeNumber(
	value: number | string | undefined,
): number | undefined {
	if (value === undefined || typeof value === 'number') {
		return value;
	}

	const parsed = Number(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}
