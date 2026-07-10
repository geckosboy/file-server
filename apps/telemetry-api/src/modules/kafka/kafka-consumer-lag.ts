import type { Admin } from 'kafkajs';

export type KafkaLagProbe = Pick<
	Admin,
	'connect' | 'disconnect' | 'fetchOffsets' | 'fetchTopicOffsets'
>;

export interface KafkaPartitionLag {
	partition: number;
	brokerOffset: string;
	groupOffset: string;
	lag: number;
}

export interface KafkaLagSnapshot {
	consumerLag: number;
	partitions: KafkaPartitionLag[];
	checkedAt: string;
}

export async function readKafkaConsumerLag(
	probe: KafkaLagProbe,
	input: { topic: string; groupId: string; now?: () => Date },
): Promise<KafkaLagSnapshot> {
	const [brokerOffsets, groupOffsets] = await Promise.all([
		probe.fetchTopicOffsets(input.topic),
		probe.fetchOffsets({
			groupId: input.groupId,
			topics: [input.topic],
			resolveOffsets: false,
		}),
	]);
	const groupTopic = groupOffsets.find(({ topic }) => topic === input.topic);
	const groupOffsetByPartition = new Map(
		(groupTopic?.partitions ?? []).map(({ offset, partition }) => [
			partition,
			offset,
		]),
	);
	const partitions = brokerOffsets.map(({ high, low, partition }) => {
		const storedGroupOffset = groupOffsetByPartition.get(partition);
		const groupOffset =
			storedGroupOffset && BigInt(storedGroupOffset) >= 0n
				? storedGroupOffset
				: low;
		return {
			partition,
			brokerOffset: high,
			groupOffset,
			lag: toSafeLag(BigInt(high) - BigInt(groupOffset)),
		};
	});

	return {
		consumerLag: toSafeLag(
			partitions.reduce((total, item) => total + BigInt(item.lag), 0n),
		),
		partitions,
		checkedAt: (input.now ?? (() => new Date()))().toISOString(),
	};
}

function toSafeLag(value: bigint): number {
	if (value <= 0n) {
		return 0;
	}
	const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
	return Number(value > maxSafe ? maxSafe : value);
}
