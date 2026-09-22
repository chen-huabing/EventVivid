import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface TenantTable { id: string; name: string; status: 'active' | 'suspended'; valid_until: Timestamp | null; support_contact: Generated<string>; timezone: Generated<string>; created_at: GeneratedTimestamp; }
export interface UserTable {
  id: string; tenant_id: string; name: string; username: string | null; password_hash: string | null;
  mobile: string | null; role: string; permissions: Generated<unknown>; status: 'active' | 'disabled'; last_login_at: Timestamp | null; created_at: GeneratedTimestamp;
}
export interface PasswordResetCodeTable { id: string; mobile: string; code_hash: string; expires_at: Timestamp; consumed_at: Timestamp | null; created_at: GeneratedTimestamp; }
export interface EventTable {
  id: string; tenant_id: string; title: string; slug: string; description: string; venue: string; hero_color: string; form_background_color: string;
  starts_at: Timestamp; ends_at: Timestamp; status: 'draft' | 'published' | 'cancelled' | 'ended';
  registration_form: Generated<unknown>; created_by: string; created_at: GeneratedTimestamp; updated_at: GeneratedTimestamp;
}
export interface TicketTypeTable {
  id: string; tenant_id: string; event_id: string; name: string; price_cents: number; capacity: number;
  sold_count: Generated<number>; sale_starts_at: Timestamp; sale_ends_at: Timestamp; created_at: GeneratedTimestamp;
}
export interface RegistrationTable {
  id: string; tenant_id: string; event_id: string; ticket_type_id: string; attendee_name: string;
  attendee_mobile: string; attendee_email: string | null; form_data: Generated<unknown>; status: 'pending_payment' | 'confirmed' | 'cancelled' | 'refunded'; created_at: GeneratedTimestamp;
}
export interface OrderTable {
  id: string; tenant_id: string; event_id: string; registration_id: string; order_no: string;
  amount_cents: number; status: 'pending' | 'paid' | 'closed' | 'refunded'; paid_at: Timestamp | null; created_at: GeneratedTimestamp;
}
export interface TicketTable {
  id: string; tenant_id: string; event_id: string; registration_id: string; code: string;
  status: 'valid' | 'checked_in' | 'void' | 'refunded'; checked_in_at: Timestamp | null; created_at: GeneratedTimestamp;
}
export interface CheckinPointTable { id: string; tenant_id: string; event_id: string; name: string; active: Generated<boolean>; created_at: GeneratedTimestamp; }
export interface CheckinPointStaffTable { checkin_point_id: string; user_id: string; created_at: GeneratedTimestamp; }
export interface CheckinRecordTable {
  id: string; tenant_id: string; event_id: string; ticket_id: string; checkin_point_id: string;
  operator_id: string; result: 'success' | 'duplicate' | 'invalid'; created_at: GeneratedTimestamp;
}
export interface OutboxEventTable {
  id: string; tenant_id: string; aggregate_type: string; aggregate_id: string; event_type: string;
  payload: unknown; published_at: Timestamp | null; created_at: GeneratedTimestamp;
}
export interface IdempotencyKeyTable { tenant_id: string; scope: string; key: string; response: unknown; created_at: GeneratedTimestamp; }
export interface PlatformUserTable {
  id: string; username: string; display_name: string; password_hash: string;
  role: 'super_admin' | 'operations' | 'finance' | 'auditor'; status: 'active' | 'disabled';
  last_login_at: Timestamp | null; created_at: GeneratedTimestamp;
}
export interface PlatformAuditLogTable {
  id: string; platform_user_id: string; action: string; target_type: string; target_id: string | null;
  detail: unknown; ip_address: string | null; created_at: GeneratedTimestamp;
}
export interface SubscriptionPlanTable {
  id: string; code: string; name: string; price_cents: number; event_limit: number | null;
  attendee_limit: number | null; status: 'active' | 'disabled'; created_at: GeneratedTimestamp;
}

export interface Database {
  tenants: TenantTable; users: UserTable; password_reset_codes: PasswordResetCodeTable; events: EventTable; ticket_types: TicketTypeTable;
  registrations: RegistrationTable; orders: OrderTable; tickets: TicketTable; checkin_points: CheckinPointTable; checkin_point_staff: CheckinPointStaffTable;
  checkin_records: CheckinRecordTable; outbox_events: OutboxEventTable; idempotency_keys: IdempotencyKeyTable;
  platform_users: PlatformUserTable; platform_audit_logs: PlatformAuditLogTable; subscription_plans: SubscriptionPlanTable;
}
