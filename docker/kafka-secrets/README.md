# Kafka production secret mount

This directory is the default read-only secret mount for `docker-compose.kafka.yml`.
Only this README is tracked. Supply the following files from the deployment
secret manager before starting the production Kafka compose:

- `kafka-broker-1.keystore.p12`
- `kafka-broker-2.keystore.p12`
- `kafka-broker-3.keystore.p12`
- `kafka.truststore.p12`
- `broker-admin.properties`

Each broker certificate must include its broker DNS name and advertised
external DNS name in the certificate SAN. Passwords come from the
`KAFKA_SSL_*_PASSWORD`, `KAFKA_BROKER_ADMIN_PASSWORD`, and
`KAFKA_ADMIN_PASSWORD` environment variables; do not write them in this file.

`broker-admin.properties` is used only on the internal listener by broker
health checks and Kafka CLI provisioning. Generate it at deployment time with
this shape and the same `KAFKA_BROKER_ADMIN_PASSWORD` value:

```properties
security.protocol=SASL_PLAINTEXT
sasl.mechanism=PLAIN
sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username="broker_admin" password="REPLACE_AT_DEPLOYMENT";
```

External clients use `SASL_SSL`; distribute the CA certificate, client topic,
consumer group, SCRAM username, and SCRAM password through the owning
project's secret/configuration system.
