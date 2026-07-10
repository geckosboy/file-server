import { headers } from 'next/headers';
import {
	authenticateAdminWebHeaders,
	createAdminAuditHeaders,
} from './admin-auth-policy';

export async function requireAdminWebSession() {
	return authenticateAdminWebHeaders(await headers());
}

export async function getCurrentAdminAuditHeaders() {
	return createAdminAuditHeaders(await requireAdminWebSession());
}
