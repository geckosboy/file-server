import { Inject, Injectable } from '@nestjs/common';
import NodeCache from 'node-cache';

export interface CachedImage {
	imageBuffer: Buffer;
	contentType: string;
}

@Injectable()
export class CacheService {
	private imageCache: NodeCache;

	constructor(@Inject('CACHE_TTL') private readonly ttl: number) {
		this.imageCache = new NodeCache({
			stdTTL: this.ttl,
			maxKeys: 1000,
			useClones: false,
		}); // 10분 TTL, 최대 1000개 이미지 캐시
	}

	cacheImage(key: string, data: CachedImage): void {
		this.imageCache.set(key, data);
	}

	getCachedImage(key: string): CachedImage | undefined {
		return this.imageCache.get<CachedImage>(key);
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
}
