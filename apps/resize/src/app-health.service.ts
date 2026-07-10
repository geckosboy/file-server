import { Injectable } from '@nestjs/common';
import { Kafka, logLevel } from 'kafkajs';
import {
	getClientServiceAuthMetricsSnapshot,
	PrismaService,
} from '@file/database';
import {
	getUpstreamFetchMetricsSnapshot,
	readKafkaClientSecurityOptions,
} from '@file/nest-common';
import { getImageTelemetryProducerStatus } from '@file/telemetry-contracts';
import { AppConfig } from './config/env.schema';

interface DependencyHealth {
	ok: boolean;
	checkedAt: string;
	latencyMs: number;
	error?: string;
}

@Injectable()
export class AppHealthService {
	private kafkaProbeCache?: { expiresAt: number; error?: Error };
	private kafkaProbeInFlight?: Promise<void>;

	constructor(
		private readonly config: AppConfig,
		private readonly prisma: PrismaService,
	) {}

	getLive() {
		return {
			ok: true,
			service: 'resize',
			checkedAt: new Date().toISOString(),
		};
	}

	async getReady() {
		const [database, kafka, storage] = await Promise.all([
			probe(() => this.prisma.$queryRaw`SELECT 1`, this.config),
			probe(() => this.probeKafka(), this.config),
			probe(
				() => probeHttpReady(this.config.STORAGE_SERVER, this.config),
				this.config,
			),
		]);
		return {
			ok: database.ok && kafka.ok && storage.ok,
			service: 'resize',
			checkedAt: new Date().toISOString(),
			dependencies: { database, kafka, storage },
			operationalMetrics: {
				upstream: readUpstreamMetrics('storage'),
				auth: getClientServiceAuthMetricsSnapshot(),
				telemetryProducer: getImageTelemetryProducerStatus(),
			},
		};
	}

	private async probeKafka(): Promise<void> {
		const cached = this.kafkaProbeCache;
		if (cached && cached.expiresAt > Date.now()) {
			if (cached.error) throw cached.error;
			return;
		}
		if (this.kafkaProbeInFlight) return this.kafkaProbeInFlight;
		this.kafkaProbeInFlight = this.runKafkaProbe()
			.then(() => {
				this.kafkaProbeCache = {
					expiresAt: Date.now() + readProbeCacheTtlMs(this.config),
				};
			})
			.catch((error: unknown) => {
				const normalized =
					error instanceof Error ? error : new Error(String(error));
				this.kafkaProbeCache = {
					expiresAt: Date.now() + readProbeCacheTtlMs(this.config),
					error: normalized,
				};
				throw normalized;
			})
			.finally(() => {
				this.kafkaProbeInFlight = undefined;
			});
		return this.kafkaProbeInFlight;
	}

	private async runKafkaProbe(): Promise<void> {
		if (this.config.kafkaClientBrokerList.length === 0) {
			throw new Error('Kafka broker configuration is empty');
		}
		const timeoutMs = readProbeTimeoutMs(this.config);
		const admin = new Kafka({
			brokers: this.config.kafkaClientBrokerList,
			clientId: 'resize-health',
			...readKafkaClientSecurityOptions(),
			logLevel: logLevel.NOTHING,
			connectionTimeout: timeoutMs,
			requestTimeout: timeoutMs,
		}).admin();
		try {
			await admin.connect();
			await admin.describeCluster();
		} finally {
			await withTimeout(admin.disconnect(), timeoutMs).catch(() => undefined);
		}
	}
}

async function probe(
	operation: () => Promise<unknown>,
	config?: Pick<AppConfig, 'HEALTH_PROBE_TIMEOUT_MS'>,
): Promise<DependencyHealth> {
	const startedAt = performance.now();
	try {
		await withTimeout(operation(), readProbeTimeoutMs(config));
		return {
			ok: true,
			checkedAt: new Date().toISOString(),
			latencyMs: Math.round(performance.now() - startedAt),
		};
	} catch (error) {
		return {
			ok: false,
			checkedAt: new Date().toISOString(),
			latencyMs: Math.round(performance.now() - startedAt),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function probeHttpReady(
	baseUrl: string,
	config?: Pick<AppConfig, 'HEALTH_PROBE_TIMEOUT_MS'>,
): Promise<void> {
	const response = await fetch(`${baseUrl.replace(/\/$/, '')}/health/ready`, {
		signal: AbortSignal.timeout(readProbeTimeoutMs(config)),
	});
	try {
		if (!response.ok) {
			throw new Error(`upstream readiness returned ${response.status}`);
		}
	} finally {
		await response.body?.cancel();
	}
}

function readProbeTimeoutMs(
	config?: Pick<AppConfig, 'HEALTH_PROBE_TIMEOUT_MS'>,
): number {
	const parsed =
		config?.HEALTH_PROBE_TIMEOUT_MS ??
		Number(process.env.HEALTH_PROBE_TIMEOUT_MS);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : 2_000;
}

function readProbeCacheTtlMs(
	config?: Pick<AppConfig, 'HEALTH_PROBE_CACHE_TTL_MS'>,
): number {
	const parsed =
		config?.HEALTH_PROBE_CACHE_TTL_MS ??
		Number(process.env.HEALTH_PROBE_CACHE_TTL_MS);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : 1_000;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error('health probe cleanup timed out')),
					timeoutMs,
				);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function readUpstreamMetrics(upstream: 'resize' | 'storage') {
	const snapshot = getUpstreamFetchMetricsSnapshot();
	return { available: true, ...snapshot[upstream] };
}
