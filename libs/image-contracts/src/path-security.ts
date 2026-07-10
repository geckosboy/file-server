import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import * as path from 'path';

const MAX_PATH_LENGTH = 256;
export const MAX_SAFE_FILE_NAME_LENGTH = 128;
export const MAX_IMAGE_STORAGE_KEY_LENGTH = 384;
const encodedTokenPattern = /%[0-9a-f]{2}/i;
const windowsAbsolutePathPattern = /^[a-z]:/i;

const normalizeUnicode = (value: string) => value.normalize('NFKC');

const rejectUnsafePathToken = (value: string, label: string) => {
	if (
		!value ||
		value.length > MAX_PATH_LENGTH ||
		containsControlCharacter(value) ||
		encodedTokenPattern.test(value)
	) {
		throw new BadRequestException(`${label} 경로 값이 안전하지 않습니다.`);
	}
};

const containsControlCharacter = (value: string) =>
	[...value].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 31 || codePoint === 127;
	});

/**
 * URL decoding 이후의 상대 경로를 하나의 canonical 표현으로 만든다.
 * 남아 있는 percent-encoding은 이중 인코딩 우회를 막기 위해 허용하지 않는다.
 */
export const normalizeSafeRelativePath = (value: string, label = 'path') => {
	const unicodeNormalized = normalizeUnicode(value);
	rejectUnsafePathToken(unicodeNormalized, label);

	if (
		unicodeNormalized.includes('\\') ||
		path.posix.isAbsolute(unicodeNormalized) ||
		windowsAbsolutePathPattern.test(unicodeNormalized)
	) {
		throw new BadRequestException(`${label}는 안전한 상대 경로여야 합니다.`);
	}

	const rawSegments = unicodeNormalized.split('/');
	const normalized = path.posix.normalize(unicodeNormalized);
	const segments = normalized.split('/');
	if (
		normalized.startsWith('../') ||
		normalized === '..' ||
		rawSegments.some(
			(segment) => !segment || segment === '.' || segment === '..',
		) ||
		segments.some((segment) => !segment || segment === '.' || segment === '..')
	) {
		throw new BadRequestException(`${label} 경로 값이 안전하지 않습니다.`);
	}

	return normalized;
};

export const normalizeSafeFileName = (value: string, label = 'name') => {
	const unicodeNormalized = normalizeUnicode(value);
	rejectUnsafePathToken(unicodeNormalized, label);

	if (
		unicodeNormalized.includes('/') ||
		unicodeNormalized.includes('\\') ||
		unicodeNormalized === '.' ||
		unicodeNormalized === '..' ||
		unicodeNormalized.includes('..')
	) {
		throw new BadRequestException(`${label} 파일명이 안전하지 않습니다.`);
	}

	const safeName = unicodeNormalized
		.replace(/[^A-Za-z0-9._-]/g, '_')
		.slice(0, MAX_SAFE_FILE_NAME_LENGTH);
	if (!safeName) {
		throw new BadRequestException(`${label} 파일명이 비어 있습니다.`);
	}

	return safeName;
};

/** storage upload/delete API가 사용하는 `.../image` 경로를 검증한다. */
export const normalizeImageStoragePath = (value: string) => {
	const normalized = normalizeSafeRelativePath(value, 'image path');
	if (normalized.split('/').at(-1) !== 'image') {
		throw new BadRequestException('image path는 /image로 끝나야 합니다.');
	}
	return normalized;
};

export const getMaxImageFileNameLengthForPath = (value: string) => {
	const normalizedPath = normalizeImageStoragePath(value);
	return Math.min(
		MAX_SAFE_FILE_NAME_LENGTH,
		MAX_IMAGE_STORAGE_KEY_LENGTH - normalizedPath.length - 1,
	);
};

export const createBoundedImageVariantName = (input: {
	name: string;
	path: string;
	width?: number | null;
	height?: number | null;
	format: 'png' | 'jpeg' | 'webp';
}) => {
	const maximumLength = getMaxImageFileNameLengthForPath(input.path);
	const extensionIndex = input.name.lastIndexOf('.');
	const baseName =
		extensionIndex > 0 ? input.name.slice(0, extensionIndex) : input.name;
	const variantSuffix = `__w${input.width ?? 'auto'}_h${input.height ?? 'auto'}.${input.format}`;
	if (baseName.length + variantSuffix.length <= maximumLength) {
		return `${baseName}${variantSuffix}`;
	}

	const identity = createHash('sha256')
		.update(input.name)
		.digest('hex')
		.slice(0, 12);
	const identitySegment = `__${identity}`;
	const maximumBaseLength =
		maximumLength - identitySegment.length - variantSuffix.length;
	if (maximumBaseLength < 1) {
		throw new BadRequestException(
			'variant filename 상한이 variant specification보다 작습니다.',
		);
	}
	return `${baseName.slice(0, maximumBaseLength)}${identitySegment}${variantSuffix}`;
};

/** cache/resize/read API의 public path를 실제 storage/policy 경로로 변환한다. */
export const toImageStoragePath = (publicPath: string) =>
	`${normalizeSafeRelativePath(publicPath, 'image path')}/image`;

export const splitAndNormalizeImageKey = (imageKey: string) => {
	const unicodeNormalized = normalizeUnicode(imageKey);
	const separatorIndex = unicodeNormalized.lastIndexOf('/');
	if (separatorIndex <= 0 || separatorIndex === unicodeNormalized.length - 1) {
		throw new BadRequestException('imageKey 형식이 잘못되었습니다.');
	}

	return {
		path: normalizeImageStoragePath(unicodeNormalized.slice(0, separatorIndex)),
		name: normalizeSafeFileName(unicodeNormalized.slice(separatorIndex + 1)),
	};
};

/** `*`(한 segment), `**`(0개 이상 segment)만 허용하는 bounded glob이다. */
export const normalizeClientServicePathPattern = (value: string) => {
	const unicodeNormalized = normalizeUnicode(value);
	rejectUnsafePathToken(unicodeNormalized, 'pathPattern');
	if (
		unicodeNormalized.includes('\\') ||
		path.posix.isAbsolute(unicodeNormalized) ||
		windowsAbsolutePathPattern.test(unicodeNormalized)
	) {
		throw new BadRequestException('pathPattern은 안전한 상대 경로여야 합니다.');
	}

	const segments = unicodeNormalized.split('/');
	if (
		segments.some(
			(segment) =>
				!segment ||
				segment === '.' ||
				segment === '..' ||
				(segment.includes('*') && segment !== '*' && segment !== '**'),
		)
	) {
		throw new BadRequestException(
			'pathPattern에는 완전한 segment 형태의 * 또는 **만 사용할 수 있습니다.',
		);
	}

	return segments.join('/');
};

export const matchesClientServicePathPattern = (
	normalizedPath: string,
	pathPattern: string,
) => {
	const pathSegments = normalizeSafeRelativePath(
		normalizedPath,
		'authorization path',
	).split('/');
	const patternSegments =
		normalizeClientServicePathPattern(pathPattern).split('/');
	const memo = new Map<string, boolean>();

	const matches = (pathIndex: number, patternIndex: number): boolean => {
		const key = `${pathIndex}:${patternIndex}`;
		const cached = memo.get(key);
		if (cached !== undefined) return cached;

		let result: boolean;
		if (patternIndex === patternSegments.length) {
			result = pathIndex === pathSegments.length;
		} else if (patternSegments[patternIndex] === '**') {
			result =
				matches(pathIndex, patternIndex + 1) ||
				(pathIndex < pathSegments.length &&
					matches(pathIndex + 1, patternIndex));
		} else {
			result =
				pathIndex < pathSegments.length &&
				(patternSegments[patternIndex] === '*' ||
					patternSegments[patternIndex] === pathSegments[pathIndex]) &&
				matches(pathIndex + 1, patternIndex + 1);
		}

		memo.set(key, result);
		return result;
	};

	return matches(0, 0);
};

export const resolveInside = (root: string, relativePath?: string) => {
	const resolvedRoot = path.resolve(root);
	const resolved = relativePath
		? path.resolve(resolvedRoot, relativePath)
		: resolvedRoot;
	const relative = path.relative(resolvedRoot, resolved);

	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new BadRequestException('허용된 파일 저장소 밖의 경로입니다.');
	}

	return resolved;
};
