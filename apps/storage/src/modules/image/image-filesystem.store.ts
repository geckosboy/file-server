import {
	ConflictException,
	Injectable,
	InternalServerErrorException,
	Optional,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, readdir, rename, rm, stat } from 'fs/promises';
import * as path from 'path';
import {
	normalizeImageStoragePath,
	normalizeSafeFileName,
} from '@file/image-contracts';
import { SharpStrategy } from './strategies/sharp';
import {
	ImageLifecycleFailpoint,
	ImageLifecycleFailpointService,
} from './image-lifecycle.failpoints';

const STAGING_DIRECTORY = '.staging';

export interface ImageObjectAddress {
	path: string;
	name: string;
}

export interface StagedImageObject extends ImageObjectAddress {
	stagingName: string;
	storageKey: string;
	checksum: string;
	size: number;
	format: string;
	width?: number;
	height?: number;
}

export interface StoredImageObject extends ImageObjectAddress {
	storageKey: string;
	modifiedAt: Date;
	bytes: number;
}

export interface ImageObjectInspection extends ImageObjectAddress {
	storageKey: string;
	checksum: string;
	bytes: number;
	format?: string;
	width?: number;
	height?: number;
}

export interface ImageFilesystemScan<T> {
	items: T[];
	nextCursor: string | null;
}

@Injectable()
export class ImageFilesystemStore {
	private readonly pathStrategy = new SharpStrategy();

	constructor(
		@Optional() private readonly failpoints?: ImageLifecycleFailpointService,
	) {}

	async stageImage<T extends SharpStrategy>(
		strategy: T,
		input: ImageObjectAddress & { tempName: string },
	): Promise<StagedImageObject> {
		const address = normalizeAddress(input);
		const tempName = normalizeSafeFileName(input.tempName, 'temp name');
		const stagingName = `${randomUUID()}.stage`;
		const stagingDirectory = this.getStagingDirectory(address.path);
		const stagingPath = path.resolve(stagingDirectory, stagingName);

		await mkdir(stagingDirectory, { recursive: true });
		try {
			const output = await strategy.compressAndSave({
				from: strategy.getTempDirectory(tempName),
				to: stagingPath,
			});
			this.failpoints?.trigger(ImageLifecycleFailpoint.AfterStageWrite);
			const stagedStats = await stat(stagingPath);
			if (output.size !== stagedStats.size || !output.format) {
				throw new InternalServerErrorException(
					'staged image metadata does not match the durable object',
				);
			}
			this.failpoints?.trigger(ImageLifecycleFailpoint.BeforeStageChecksum);
			const checksum = await checksumFile(stagingPath);
			this.failpoints?.trigger(ImageLifecycleFailpoint.AfterStageChecksum);

			return {
				...address,
				stagingName,
				storageKey: createStorageKey(address),
				checksum,
				size: stagedStats.size,
				format: output.format,
				width: output.width,
				height: output.height,
			};
		} catch (error) {
			await rm(stagingPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	async promoteImage(staged: StagedImageObject): Promise<void> {
		const address = normalizeAddress(staged);
		const stagingPath = this.getStagingPath(address.path, staged.stagingName);
		const finalPath = this.getObjectPath(address);

		if (await fileExists(finalPath)) {
			const finalChecksum = await checksumFile(finalPath);
			if (finalChecksum !== staged.checksum) {
				throw new ConflictException(
					`다른 내용의 이미지가 이미 존재합니다: ${createStorageKey(address)}`,
				);
			}
			await rm(stagingPath, { force: true });
			return;
		}

		await rename(stagingPath, finalPath);
	}

	async discardStage(staged: Pick<StagedImageObject, 'path' | 'stagingName'>) {
		await rm(this.getStagingPath(staged.path, staged.stagingName), {
			force: true,
		});
	}

	async deleteObjects(addresses: readonly ImageObjectAddress[]): Promise<void> {
		const uniqueAddresses = new Map<string, ImageObjectAddress>();
		for (const address of addresses) {
			const normalized = normalizeAddress(address);
			uniqueAddresses.set(createStorageKey(normalized), normalized);
		}

		await Promise.all(
			[...uniqueAddresses.values()].map((address) =>
				rm(this.getObjectPath(address), { force: true }),
			),
		);
	}

	async hasObject(address: ImageObjectAddress): Promise<boolean> {
		return fileExists(this.getObjectPath(normalizeAddress(address)));
	}

	async inspectObject(
		address: ImageObjectAddress,
	): Promise<ImageObjectInspection | null> {
		const normalized = normalizeAddress(address);
		const objectPath = this.getObjectPath(normalized);
		try {
			const objectStats = await stat(objectPath);
			const imageMetadata = await this.pathStrategy
				.createPipeline(objectPath)
				.metadata()
				.catch(() => undefined);
			return {
				...normalized,
				storageKey: createStorageKey(normalized),
				checksum: await checksumFile(objectPath),
				bytes: objectStats.size,
				format: imageMetadata?.format,
				width: imageMetadata?.width,
				height: imageMetadata?.height,
			};
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') return null;
			throw error;
		}
	}

	async listObjects(limit = 1_000): Promise<StoredImageObject[]> {
		return (await this.scanObjects({ limit })).items;
	}

	async scanObjects(input: {
		limit: number;
		cursor?: string;
	}): Promise<ImageFilesystemScan<StoredImageObject>> {
		const root = this.pathStrategy.getMainDirectory();
		const limit = normalizeLimit(input.limit);
		const files = await walkFiles(root, limit + 1, [], {
			shouldEnterDirectory: (entry) => entry !== STAGING_DIRECTORY,
			includeFile: (file) => {
				const relativeDirectory = path
					.relative(root, path.dirname(file))
					.split(path.sep)
					.join('/');
				return relativeDirectory.endsWith('/image');
			},
			afterCursor: input.cursor,
			root,
		});
		const objects: StoredImageObject[] = [];

		for (const file of files.slice(0, limit)) {
			const relative = path.relative(root, file);
			const segments = relative.split(path.sep);
			if (segments.includes(STAGING_DIRECTORY) || segments.length < 2) {
				continue;
			}

			const name = segments.at(-1);
			const storagePath = segments.slice(0, -1).join('/');
			if (!name || !storagePath.endsWith('/image')) {
				continue;
			}

			const address = normalizeAddress({ path: storagePath, name });
			const objectStats = await statIfExists(file);
			if (!objectStats) continue;
			objects.push({
				...address,
				storageKey: createStorageKey(address),
				modifiedAt: objectStats.mtime,
				bytes: objectStats.size,
			});
		}

		const sorted = objects.sort((left, right) =>
			left.storageKey.localeCompare(right.storageKey),
		);
		return {
			items: sorted,
			nextCursor:
				files.length > limit ? (sorted.at(-1)?.storageKey ?? null) : null,
		};
	}

	async cleanupStagedObjects(
		olderThan: Date,
		limit = 1_000,
	): Promise<string[]> {
		return (await this.scanAndCleanupStagedObjects({ olderThan, limit })).items;
	}

	async scanAndCleanupStagedObjects(input: {
		olderThan: Date;
		limit: number;
		cursor?: string;
	}): Promise<ImageFilesystemScan<string>> {
		const root = this.pathStrategy.getMainDirectory();
		const limit = normalizeLimit(input.limit);
		const files = await walkFiles(root, limit + 1, [], {
			includeFile: (file) =>
				path.basename(path.dirname(file)) === STAGING_DIRECTORY,
			afterCursor: input.cursor,
			root,
		});
		const removed: string[] = [];

		for (const file of files.slice(0, limit)) {
			const relative = path.relative(root, file);
			const segments = relative.split(path.sep);
			if (!segments.includes(STAGING_DIRECTORY)) {
				continue;
			}
			const stagedStats = await statIfExists(file);
			if (!stagedStats) continue;
			if (stagedStats.mtime > input.olderThan) {
				continue;
			}

			await rm(file, { force: true });
			removed.push(relative.split(path.sep).join('/'));
		}

		return {
			items: removed.sort(),
			nextCursor:
				files.length > limit ? toRelativeCursor(root, files[limit - 1]) : null,
		};
	}

	async scanAndCleanupInboundTempFiles(input: {
		olderThan: Date;
		limit: number;
		cursor?: string;
	}): Promise<ImageFilesystemScan<string>> {
		const root = this.pathStrategy.getTempDirectory();
		const limit = normalizeLimit(input.limit);
		const files = await walkFiles(root, limit + 1, [], {
			afterCursor: input.cursor,
			root,
		});
		const removed: string[] = [];

		for (const file of files.slice(0, limit)) {
			const fileStats = await statIfExists(file);
			if (!fileStats) continue;
			if (fileStats.mtime > input.olderThan) continue;
			await rm(file, { force: true });
			removed.push(toRelativeCursor(root, file));
		}

		return {
			items: removed.sort(),
			nextCursor:
				files.length > limit ? toRelativeCursor(root, files[limit - 1]) : null,
		};
	}

	private getObjectPath(address: ImageObjectAddress) {
		return this.pathStrategy.getMainDirectory(
			`${address.path}/${address.name}`,
		);
	}

	private getStagingDirectory(storagePath: string) {
		const normalizedPath = normalizeImageStoragePath(storagePath);
		return path.resolve(
			this.pathStrategy.getMainDirectory(normalizedPath),
			STAGING_DIRECTORY,
		);
	}

	private getStagingPath(storagePath: string, stagingName: string) {
		return path.resolve(
			this.getStagingDirectory(storagePath),
			normalizeSafeFileName(stagingName, 'staging name'),
		);
	}
}

export const createStorageKey = (address: ImageObjectAddress) =>
	`${address.path}/${address.name}`;

const normalizeAddress = (address: ImageObjectAddress): ImageObjectAddress => ({
	path: normalizeImageStoragePath(address.path),
	name: normalizeSafeFileName(address.name),
});

const fileExists = async (file: string) => {
	try {
		await stat(file);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT') {
			return false;
		}
		throw error;
	}
};

const statIfExists = async (file: string) => {
	try {
		return await stat(file);
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT') return null;
		throw error;
	}
};

const checksumFile = async (file: string) => {
	const hash = createHash('sha256');
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(file);
		stream.on('data', (chunk) => hash.update(chunk));
		stream.on('error', reject);
		stream.on('end', resolve);
	});
	return hash.digest('hex');
};

const walkFiles = async (
	directory: string,
	limit: number,
	files: string[] = [],
	options: {
		includeFile?: (file: string) => boolean;
		shouldEnterDirectory?: (name: string) => boolean;
		afterCursor?: string;
		root?: string;
	} = {},
): Promise<string[]> => {
	if (files.length >= limit) {
		return files;
	}
	let entries;
	try {
		entries = (await readdir(directory, { withFileTypes: true })).sort(
			(left, right) => left.name.localeCompare(right.name),
		);
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT') {
			return [];
		}
		throw error;
	}

	for (const entry of entries) {
		if (files.length >= limit) {
			break;
		}
		const entryPath = path.resolve(directory, entry.name);
		if (
			entry.isDirectory() &&
			(options.shouldEnterDirectory?.(entry.name) ?? true)
		) {
			await walkFiles(entryPath, limit, files, options);
		} else if (
			entry.isFile() &&
			(options.includeFile?.(entryPath) ?? true) &&
			(!options.afterCursor ||
				toRelativeCursor(options.root ?? directory, entryPath) >
					options.afterCursor)
		) {
			files.push(entryPath);
		}
	}
	return files;
};

const normalizeLimit = (limit: number) =>
	Number.isInteger(limit) && limit > 0 ? limit : 1_000;

const toRelativeCursor = (root: string, file: string) =>
	path.relative(root, file).split(path.sep).join('/');

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
	typeof error === 'object' && error !== null && 'code' in error;
