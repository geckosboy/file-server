import { Inject, Injectable } from '@nestjs/common';
import * as NodeCache from 'node-cache';

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
}
