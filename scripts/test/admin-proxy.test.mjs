import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = readFileSync(
	new URL('../../docker/nginx/admin.conf.example', import.meta.url),
	'utf8',
);

test('admin Nginx re-resolves the Docker backend and overwrites auth headers', () => {
	assert.match(config, /resolver 127\.0\.0\.11 valid=5s ipv6=off;/);
	assert.match(config, /set \$admin_web_upstream file_server_admin-web:3000;/);
	assert.match(config, /proxy_pass http:\/\/\$admin_web_upstream;/);
	assert.match(config, /proxy_set_header X-File-Admin-User \$remote_user;/);
	assert.match(
		config,
		/proxy_set_header X-File-Admin-Proxy-Secret "REPLACE_WITH_ADMIN_WEB_PROXY_SECRET";/,
	);
	assert.doesNotMatch(config, /proxy_pass http:\/\/file_server_admin-web:3000/);
});
