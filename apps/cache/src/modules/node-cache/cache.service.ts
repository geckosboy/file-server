import { Inject, Injectable, Optional } from '@nestjs/common';
import NodeCache from 'node-cache';

const DEFAULT_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const CACHE_MAX_KEYS = 1000;

export interface CachedImage {
	imageBuffer: Buffer;
	contentType: string;
}

export interface CacheMetrics {
	hits: number;
	misses: number;
	entries: number;
	bytes: number;
	maxBytes: number;
	evictions: number;
	oversizedSkips: number;
}

interface CacheEntryMetadata {
	bytes: number;
	lastAccess: number;
}

@Injectable()
export class CacheService {
	private readonly imageCache: NodeCache;
	private readonly maxBytes: number;
	private readonly entries = new Map<string, CacheEntryMetadata>();
	private currentBytes = 0;
	private accessSequence = 0;
	private hits = 0;
	private misses = 0;
	private evictions = 0;
	private oversizedSkips = 0;

	constructor(
		@Inject('CACHE_TTL') private readonly ttl: number,
		@Optional() @Inject('CACHE_MAX_BYTES') configuredMaxBytes?: number,
	) {
		this.maxBytes = resolveMaxBytes(configuredMaxBytes);
		this.imageCache = new NodeCache({
			stdTTL: this.ttl,
			maxKeys: CACHE_MAX_KEYS,
			useClones: false,
		});
		this.imageCache.on('del', (key: string) => {
			this.removeMetadata(key);
		});
		this.imageCache.on('expired', (key: string) => {
			this.removeMetadata(key);
		});
		this.imageCache.on('flush', () => {
			this.entries.clear();
			this.currentBytes = 0;
		});
	}

	cacheImage(key: string, data: CachedImage): void {
		const bytes = data.imageBuffer.byteLength;
		if (bytes > this.maxBytes) {
			this.oversizedSkips += 1;
			return;
		}

		if (this.entries.has(key)) {
			this.deleteKey(key);
		}
		this.evictUntilWithinBudget(bytes);
		const stored = this.imageCache.set(key, data);
		if (!stored) {
			return;
		}
		this.entries.set(key, {
			bytes,
			lastAccess: this.nextAccessSequence(),
		});
		this.currentBytes += bytes;
	}

	getCachedImage(key: string): CachedImage | undefined {
		const cachedImage = this.imageCache.get<CachedImage>(key);
		if (!cachedImage) {
			this.misses += 1;
			this.removeMetadata(key);
			return undefined;
		}

		this.hits += 1;
		const metadata = this.entries.get(key);
		if (metadata) {
			metadata.lastAccess = this.nextAccessSequence();
		}
		return cachedImage;
	}

	getMetrics(): CacheMetrics {
		return {
			hits: this.hits,
			misses: this.misses,
			entries: this.entries.size,
			bytes: this.currentBytes,
			maxBytes: this.maxBytes,
			evictions: this.evictions,
			oversizedSkips: this.oversizedSkips,
		};
	}

	deleteCachedImagesForImage({
		clientServiceId,
		name,
		path,
	}: {
		clientServiceId: string;
		path: string;
		name: string;
	}): number {
		const keys = this.imageCache.keys().filter((key) => {
			const [cacheClientServiceId, cachePath, , , , cacheName, ...rest] =
				key.split('|');
			if (rest.length || !cacheClientServiceId || !cachePath || !cacheName) {
				return false;
			}

			try {
				return (
					decodeURIComponent(cacheClientServiceId) === clientServiceId &&
					decodeURIComponent(cachePath) === path &&
					decodeURIComponent(cacheName) === name
				);
			} catch {
				return false;
			}
		});

		if (!keys.length) {
			return 0;
		}

		return this.imageCache.del(keys);
	}

	private evictUntilWithinBudget(incomingBytes: number): void {
		while (
			this.entries.size >= CACHE_MAX_KEYS ||
			this.currentBytes + incomingBytes > this.maxBytes
		) {
			const lruKey = this.findLeastRecentlyUsedKey();
			if (!lruKey) {
				break;
			}
			this.deleteKey(lruKey);
			this.evictions += 1;
		}
	}

	private findLeastRecentlyUsedKey(): string | undefined {
		let lruKey: string | undefined;
		let lruAccess = Number.POSITIVE_INFINITY;
		for (const [key, metadata] of this.entries) {
			if (metadata.lastAccess < lruAccess) {
				lruKey = key;
				lruAccess = metadata.lastAccess;
			}
		}
		return lruKey;
	}

	private deleteKey(key: string): void {
		this.imageCache.del(key);
		this.removeMetadata(key);
	}

	private removeMetadata(key: string): void {
		const metadata = this.entries.get(key);
		if (!metadata) {
			return;
		}
		this.entries.delete(key);
		this.currentBytes = Math.max(0, this.currentBytes - metadata.bytes);
	}

	private nextAccessSequence(): number {
		this.accessSequence += 1;
		return this.accessSequence;
	}
}

function resolveMaxBytes(configuredMaxBytes: number | undefined): number {
	const environmentMaxBytes = Number(process.env.CACHE_MAX_BYTES);
	if (
		configuredMaxBytes !== undefined &&
		Number.isSafeInteger(configuredMaxBytes) &&
		configuredMaxBytes > 0
	) {
		return configuredMaxBytes;
	}
	if (Number.isSafeInteger(environmentMaxBytes) && environmentMaxBytes > 0) {
		return environmentMaxBytes;
	}
	return DEFAULT_CACHE_MAX_BYTES;
}
