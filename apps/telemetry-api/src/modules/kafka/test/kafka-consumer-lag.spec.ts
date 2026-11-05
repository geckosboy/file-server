import { KafkaLagProbe, readKafkaConsumerLag } from '../kafka-consumer-lag';

describe('Kafka consumer lag probe', () => {
	it('broker high offset과 consumer group offset 차이를 partition별로 합산한다', async () => {
		const probe: jest.Mocked<KafkaLagProbe> = {
			connect: jest.fn(),
			disconnect: jest.fn(),
			fetchTopicOffsets: jest.fn().mockResolvedValue([
				{ partition: 0, offset: '12', high: '12', low: '2' },
				{ partition: 1, offset: '9', high: '9', low: '3' },
			]),
			fetchOffsets: jest.fn().mockResolvedValue([
				{
					topic: 'events',
					partitions: [
						{ partition: 0, offset: '7', metadata: null },
						{ partition: 1, offset: '8', metadata: null },
					],
				},
			]),
		};

		await expect(
			readKafkaConsumerLag(probe, {
				topic: 'events',
				groupId: 'group-a',
				now: () => new Date('2026-07-10T00:00:00.000Z'),
			}),
		).resolves.toEqual({
			consumerLag: 6,
			checkedAt: '2026-07-10T00:00:00.000Z',
			partitions: [
				{
					partition: 0,
					brokerOffset: '12',
					groupOffset: '7',
					lag: 5,
				},
				{
					partition: 1,
					brokerOffset: '9',
					groupOffset: '8',
					lag: 1,
				},
			],
		});
	});

	it('초기화되지 않은 group offset은 broker low offset부터 계산한다', async () => {
		const probe: jest.Mocked<KafkaLagProbe> = {
			connect: jest.fn(),
			disconnect: jest.fn(),
			fetchTopicOffsets: jest
				.fn()
				.mockResolvedValue([
					{ partition: 0, offset: '10', high: '10', low: '4' },
				]),
			fetchOffsets: jest.fn().mockResolvedValue([
				{
					topic: 'events',
					partitions: [{ partition: 0, offset: '-1', metadata: null }],
				},
			]),
		};

		const result = await readKafkaConsumerLag(probe, {
			topic: 'events',
			groupId: 'new-group',
		});

		expect(result.partitions[0]).toMatchObject({ groupOffset: '4', lag: 6 });
	});

	it('partition별 포화 합계도 MAX_SAFE_INTEGER를 넘지 않는다', async () => {
		const probe: jest.Mocked<KafkaLagProbe> = {
			connect: jest.fn(),
			disconnect: jest.fn(),
			fetchTopicOffsets: jest.fn().mockResolvedValue([
				{
					partition: 0,
					offset: '90071992547409930',
					high: '90071992547409930',
					low: '0',
				},
				{
					partition: 1,
					offset: '90071992547409930',
					high: '90071992547409930',
					low: '0',
				},
			]),
			fetchOffsets: jest.fn().mockResolvedValue([
				{
					topic: 'events',
					partitions: [
						{ partition: 0, offset: '0', metadata: null },
						{ partition: 1, offset: '0', metadata: null },
					],
				},
			]),
		};

		const result = await readKafkaConsumerLag(probe, {
			topic: 'events',
			groupId: 'group',
		});
		expect(result.consumerLag).toBe(Number.MAX_SAFE_INTEGER);
		expect(
			result.partitions.every(({ lag }) => lag === Number.MAX_SAFE_INTEGER),
		).toBe(true);
	});
});
