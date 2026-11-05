export const MAX_EVENT_LIST_TAKE = 100;

export interface EventListCursor {
	occurredAt: string;
	eventId: string;
}

export interface EventListQuery {
	eventType?: string;
	sourceApp?: string;
	clientServiceId?: string;
	clientServiceSlug?: string;
	status?: string;
	from?: string;
	to?: string;
	search?: string;
	path?: string;
	name?: string;
	imageKey?: string;
	requestId?: string;
	cursor?: EventListCursor;
	offset?: number;
	take: number;
}

export interface EventListPage<Event> {
	items: Event[];
	nextCursor?: EventListCursor;
}

interface EventListRecord {
	eventId: string;
	eventType: string;
	occurredAt: string;
	sourceApp: string;
	status: string;
	clientServiceId?: string;
	clientServiceSlug?: string;
	requestId?: string;
	traceId?: string;
	path: string;
	name: string;
	imageKey: string;
	errorCode?: string;
	errorMessage?: string;
}

export function listInMemoryEventPage<Event extends EventListRecord>(
	events: Iterable<Event>,
	query: EventListQuery,
): EventListPage<Event> {
	assertBoundedEventListQuery(query);

	const ordered = [...events]
		.filter((event) => matchesEventListQuery(event, query))
		.filter((event) => isAfterCursor(event, query.cursor))
		.sort(compareEventRecordsDesc);
	const offset = query.offset ?? 0;
	const rows = ordered.slice(offset, offset + query.take + 1);
	const hasMore = rows.length > query.take;
	const items = rows.slice(0, query.take);

	return {
		items,
		nextCursor: hasMore ? toEventListCursor(items.at(-1)) : undefined,
	};
}

export function assertBoundedEventListQuery(query: EventListQuery): void {
	if (
		!Number.isInteger(query.take) ||
		query.take < 1 ||
		query.take > MAX_EVENT_LIST_TAKE
	) {
		throw new RangeError(
			`event list take must be between 1 and ${MAX_EVENT_LIST_TAKE}`,
		);
	}
	if (
		query.offset !== undefined &&
		(!Number.isInteger(query.offset) || query.offset < 0)
	) {
		throw new RangeError('event list offset must be a non-negative integer');
	}
	if (query.cursor && query.offset !== undefined) {
		throw new RangeError('event list cursor and offset are mutually exclusive');
	}
	const fromTime = toOptionalTimestamp(query.from);
	const toTime = toOptionalTimestamp(query.to);
	if (fromTime !== undefined && toTime !== undefined && fromTime > toTime) {
		throw new RangeError('event list from must be earlier than to');
	}
	if (
		query.cursor &&
		(!Number.isFinite(new Date(query.cursor.occurredAt).getTime()) ||
			!query.cursor.eventId)
	) {
		throw new RangeError('event list cursor must contain a valid event key');
	}
}

export function toEventListCursor(
	event: Pick<EventListRecord, 'eventId' | 'occurredAt'> | undefined,
): EventListCursor | undefined {
	return event
		? { occurredAt: event.occurredAt, eventId: event.eventId }
		: undefined;
}

function matchesEventListQuery(
	event: EventListRecord,
	query: EventListQuery,
): boolean {
	return (
		(!query.eventType || event.eventType === query.eventType) &&
		(!query.sourceApp || event.sourceApp === query.sourceApp) &&
		(!query.clientServiceId ||
			event.clientServiceId === query.clientServiceId) &&
		(!query.clientServiceSlug ||
			event.clientServiceSlug === query.clientServiceSlug) &&
		(!query.status || event.status === query.status) &&
		matchesDateRange(event.occurredAt, query.from, query.to) &&
		(!query.path || event.path.includes(query.path)) &&
		(!query.name || event.name.includes(query.name)) &&
		(!query.imageKey || event.imageKey === query.imageKey) &&
		(!query.requestId || event.requestId === query.requestId) &&
		matchesSearch(event, query.search)
	);
}

function matchesDateRange(
	value: string,
	from: string | undefined,
	to: string | undefined,
): boolean {
	const timestamp = new Date(value).getTime();
	const fromTime = toOptionalTimestamp(from);
	const toTime = toOptionalTimestamp(to);
	return (
		(fromTime === undefined || timestamp >= fromTime) &&
		(toTime === undefined || timestamp <= toTime)
	);
}

function toOptionalTimestamp(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const timestamp = new Date(value).getTime();
	if (!Number.isFinite(timestamp)) {
		throw new RangeError('event list range must contain valid dates');
	}

	return timestamp;
}

function matchesSearch(
	event: EventListRecord,
	search: string | undefined,
): boolean {
	const normalized = search?.trim().toLowerCase();
	if (!normalized) {
		return true;
	}

	return [
		event.eventId,
		event.eventType,
		event.sourceApp,
		event.clientServiceId,
		event.clientServiceSlug,
		event.requestId,
		event.traceId,
		event.path,
		event.name,
		event.imageKey,
		event.errorCode,
		event.errorMessage,
	].some((value) => value?.toLowerCase().includes(normalized));
}

function isAfterCursor(
	event: EventListRecord,
	cursor: EventListCursor | undefined,
): boolean {
	if (!cursor) {
		return true;
	}

	const eventTime = new Date(event.occurredAt).getTime();
	const cursorTime = new Date(cursor.occurredAt).getTime();
	return (
		eventTime < cursorTime ||
		(eventTime === cursorTime && event.eventId < cursor.eventId)
	);
}

function compareEventRecordsDesc(
	left: EventListRecord,
	right: EventListRecord,
): number {
	const timeDiff =
		new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime();
	if (timeDiff !== 0) {
		return timeDiff;
	}
	if (left.eventId === right.eventId) {
		return 0;
	}

	return left.eventId < right.eventId ? 1 : -1;
}
