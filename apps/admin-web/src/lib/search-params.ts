export type PageSearchParams = Record<string, string | string[] | undefined>;

export const readSearchParam = (
	params: PageSearchParams | undefined,
	key: string,
): string | undefined => {
	const value = params?.[key];
	if (Array.isArray(value)) {
		return value[0];
	}
	return value;
};

export const readOptionalSearchParam = (
	params: PageSearchParams | undefined,
	key: string,
): string | undefined => {
	const value = readSearchParam(params, key)?.trim();
	return value === '' || value === 'all' ? undefined : value;
};

export const readRangePreset = (
	params: PageSearchParams | undefined,
	fallback = '24h',
) => readSearchParam(params, 'range') ?? fallback;

export const resolveSearchParams = async (
	searchParams?: Promise<PageSearchParams>,
) => searchParams ?? {};

export const buildRangeFromPreset = (
	preset: string,
	now: Date = new Date(),
) => {
	const durationMs =
		preset === '1h'
			? 60 * 60 * 1000
			: preset === '7d'
				? 7 * 24 * 60 * 60 * 1000
				: preset === '30d'
					? 30 * 24 * 60 * 60 * 1000
					: 24 * 60 * 60 * 1000;
	return {
		from: new Date(now.getTime() - durationMs).toISOString(),
		to: now.toISOString(),
	};
};
