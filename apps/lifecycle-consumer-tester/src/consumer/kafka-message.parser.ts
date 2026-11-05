export interface ParsedKafkaPayload {
	ok: true;
	payload: unknown;
}

export interface InvalidKafkaPayload {
	ok: false;
	reason: string;
}

export type KafkaPayloadParseResult = ParsedKafkaPayload | InvalidKafkaPayload;

export function parseKafkaMessageValue(
	value: unknown,
): KafkaPayloadParseResult {
	if (value === null || value === undefined) {
		return { ok: false, reason: 'Kafka message value is empty' };
	}

	if (Buffer.isBuffer(value)) {
		return parseJsonString(value.toString('utf8'));
	}

	if (value instanceof Uint8Array) {
		return parseJsonString(Buffer.from(value).toString('utf8'));
	}

	if (typeof value === 'string') {
		return parseJsonString(value);
	}

	return { ok: true, payload: unwrapNestKafkaPayload(value) };
}

function parseJsonString(value: string): KafkaPayloadParseResult {
	const trimmed = value.trim();
	if (!trimmed) {
		return { ok: false, reason: 'Kafka message value is empty' };
	}

	try {
		return { ok: true, payload: unwrapNestKafkaPayload(JSON.parse(trimmed)) };
	} catch {
		return { ok: false, reason: 'Kafka message value must be valid JSON' };
	}
}

function unwrapNestKafkaPayload(value: unknown): unknown {
	if (!isRecord(value) || 'schemaVersion' in value || !('value' in value)) {
		return value;
	}

	const nestedValue = value.value;
	if (typeof nestedValue === 'string') {
		try {
			return JSON.parse(nestedValue);
		} catch {
			return value;
		}
	}

	return nestedValue ?? value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
