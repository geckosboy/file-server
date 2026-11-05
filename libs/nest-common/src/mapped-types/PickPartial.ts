import { Type } from '@nestjs/common';
import {
	IntersectionType,
	OmitType,
	PartialType,
	PickType,
} from '@nestjs/mapped-types';

export default <T, K extends keyof T>(
	classRef: Type<T>,
	keyList: readonly K[],
) =>
	IntersectionType(
		OmitType(classRef, keyList),
		PartialType(PickType(classRef, keyList)),
	);
