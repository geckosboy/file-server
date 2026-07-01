import { EventStatus } from './telemetry-api';

export const formatNumber = (value: number) => value.toLocaleString('ko-KR');

export const formatPercent = (value: number | null | undefined) => {
	if (value === null || value === undefined) {
		return '데이터 없음';
	}

	return `${(value * 100).toLocaleString('ko-KR', {
		maximumFractionDigits: 1,
		minimumFractionDigits: 1,
	})}%`;
};

export const formatMs = (value: number | null | undefined) => {
	if (value === null || value === undefined) {
		return '데이터 없음';
	}

	return `${value.toLocaleString('ko-KR', {
		maximumFractionDigits: 1,
	})}ms`;
};

export const formatBytes = (value: number | undefined) => {
	if (value === undefined) {
		return '-';
	}

	if (value >= 1024 * 1024) {
		return `${(value / 1024 / 1024).toLocaleString('ko-KR', {
			maximumFractionDigits: 1,
		})}MB`;
	}

	if (value >= 1024) {
		return `${(value / 1024).toLocaleString('ko-KR', {
			maximumFractionDigits: 1,
		})}KB`;
	}

	return `${formatNumber(value)}B`;
};

export const formatDateTime = (isoDate: string) =>
	new Intl.DateTimeFormat('ko-KR', {
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	}).format(new Date(isoDate));

export const statusLabel = (status: EventStatus) =>
	status === 'success' ? '성공' : '실패';
