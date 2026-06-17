import { BadRequestException } from '@nestjs/common';
import * as path from 'path';

const encodedSeparatorPattern = /%2f|%5c/i;

const rejectUnsafePathToken = (value: string, label: string) => {
	if (!value || value.includes('\0') || encodedSeparatorPattern.test(value)) {
		throw new BadRequestException(`${label} 경로 값이 안전하지 않습니다.`);
	}
};

export const normalizeSafeRelativePath = (value: string, label = 'path') => {
	rejectUnsafePathToken(value, label);

	if (path.isAbsolute(value)) {
		throw new BadRequestException(`${label}는 상대 경로만 허용됩니다.`);
	}

	const rawSegments = value.replace(/\\/g, '/').split('/');
	const normalized = path.normalize(value).replace(/\\/g, '/');
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
	rejectUnsafePathToken(value, label);

	if (
		value.includes('/') ||
		value.includes('\\') ||
		value === '.' ||
		value === '..' ||
		value.includes('..')
	) {
		throw new BadRequestException(`${label} 파일명이 안전하지 않습니다.`);
	}

	const safeName = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
	if (!safeName) {
		throw new BadRequestException(`${label} 파일명이 비어 있습니다.`);
	}

	return safeName;
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
