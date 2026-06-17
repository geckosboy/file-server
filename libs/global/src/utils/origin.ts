/** Comma-separated CORS origin string을 정확한 문자열 allowlist로 변환합니다. */
export const parseOriginList = (originListStr?: string) =>
	originListStr
		?.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean) ?? [];
