import {
	KafkaSaslMechanism,
	readKafkaClientSecurityOptions,
} from '../kafka-client-security';

describe('Kafka client security 환경 파서', () => {
	it('보안 설정이 없으면 plaintext 개발 연결 옵션을 추가하지 않는다', () => {
		expect(readKafkaClientSecurityOptions({})).toEqual({});
	});

	it('SSL을 활성화하면 지정된 CA를 읽고 인증서 검증을 강제한다', () => {
		const readFile = jest.fn(() => 'test-ca');

		expect(
			readKafkaClientSecurityOptions(
				{
					KAFKA_SSL_ENABLED: 'true',
					KAFKA_SSL_CA_FILE: '/run/secrets/kafka-ca.crt',
				},
				readFile,
			),
		).toEqual({
			ssl: { ca: ['test-ca'], rejectUnauthorized: true },
		});
		expect(readFile).toHaveBeenCalledWith('/run/secrets/kafka-ca.crt', 'utf8');
	});

	it.each([
		['plain', KafkaSaslMechanism.Plain],
		['SCRAM-SHA-256', KafkaSaslMechanism.ScramSha256],
		['scram-sha-512', KafkaSaslMechanism.ScramSha512],
	])('%s SASL mechanism과 자격 증명을 파싱한다', (configured, expected) => {
		expect(
			readKafkaClientSecurityOptions({
				KAFKA_SASL_MECHANISM: configured,
				KAFKA_SASL_USERNAME: ' file-server ',
				KAFKA_SASL_PASSWORD: ' secret ',
			}),
		).toEqual({
			sasl: {
				mechanism: expected,
				username: 'file-server',
				password: ' secret ',
			},
		});
	});

	it('SSL 활성화 시 CA가 없으면 fail closed한다', () => {
		expect(() =>
			readKafkaClientSecurityOptions({ KAFKA_SSL_ENABLED: 'true' }),
		).toThrow('KAFKA_SSL_CA_FILE is required');
	});

	it('SSL 비활성 상태에서 CA만 제공하면 fail closed한다', () => {
		expect(() =>
			readKafkaClientSecurityOptions({
				KAFKA_SSL_ENABLED: 'false',
				KAFKA_SSL_CA_FILE: '/tmp/ca.crt',
			}),
		).toThrow('KAFKA_SSL_CA_FILE requires KAFKA_SSL_ENABLED=true');
	});

	it('알 수 없는 SSL boolean을 조용히 비활성화하지 않는다', () => {
		expect(() =>
			readKafkaClientSecurityOptions({ KAFKA_SSL_ENABLED: 'maybe' }),
		).toThrow('KAFKA_SSL_ENABLED must be true or false');
	});

	it('SASL mechanism 없이 자격 증명만 제공하면 fail closed한다', () => {
		expect(() =>
			readKafkaClientSecurityOptions({
				KAFKA_SASL_USERNAME: 'file-server',
				KAFKA_SASL_PASSWORD: 'secret',
			}),
		).toThrow('KAFKA_SASL_MECHANISM is required');
	});

	it('지원하지 않는 SASL mechanism을 거부한다', () => {
		expect(() =>
			readKafkaClientSecurityOptions({
				KAFKA_SASL_MECHANISM: 'oauthbearer',
				KAFKA_SASL_USERNAME: 'file-server',
				KAFKA_SASL_PASSWORD: 'secret',
			}),
		).toThrow('Unsupported Kafka SASL mechanism: oauthbearer');
	});

	it('SASL 사용자명 또는 비밀번호가 없으면 fail closed한다', () => {
		expect(() =>
			readKafkaClientSecurityOptions({
				KAFKA_SASL_MECHANISM: 'plain',
				KAFKA_SASL_USERNAME: 'file-server',
			}),
		).toThrow('KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD are required');
	});
});
