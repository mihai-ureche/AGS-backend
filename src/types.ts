import type { Permission } from './permissions.js';
import type { RevenueConfiguration, RevenueGroupId, RevenueUpdate } from './revenue.js';

export interface AppConfig {
  tenantId: string;
  databaseUrl: string;
  origins: string[];
  port: number;
  trustProxyHops: number;
  salesReconciliationFile?: string;
  borg?: {
    baseUrl: string;
    authorization: string;
  };
}

export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  displayName: string | null;
  email: string | null;
  isAdmin: boolean;
  role: Role;
  permissions: readonly Permission[];
  salesGroups: RevenueGroupId[] | null;
  targetEntities: TargetEntity[];
  isActive: boolean;
}

export type Role = string;
export type TargetEntity = 'agritehnica' | 'green' | 'babyhub';
export interface UserAccess {
  role: Role;
  permissions: readonly Permission[];
  salesGroups: RevenueGroupId[] | null;
  targetEntities: TargetEntity[];
  isActive: boolean;
  deletedAt: Date | null;
}
export interface UserUpdate {
  targetEntities?: TargetEntity[];
  isActive?: boolean;
}
export interface StoredRole {
  name: Role;
  description: string;
  permissions: readonly Permission[];
  salesGroups: RevenueGroupId[] | null;
}

export interface StoredUser {
  id: string;
  tenantId: string;
  microsoftUserId: string;
  displayName: string | null;
  email: string | null;
  role: Role;
  targetEntities: TargetEntity[];
  isActive: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date;
}

export type RequestStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type RequestPriority = 'low' | 'normal' | 'high';

export interface CreateRequestInput {
  title: string;
  description: string;
  priority: RequestPriority;
}

export interface SupportRequest extends CreateRequestInput {
  id: string;
  status: RequestStatus;
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RequestPage {
  status?: RequestStatus;
  limit: number;
  offset: number;
}

export interface Store {
  health(): Promise<void>;
  getUserAccess(user: AuthenticatedUser): Promise<UserAccess | undefined>;
  createRole(user: AuthenticatedUser, input: Omit<StoredRole, 'salesGroups'> & { salesGroups?: RevenueGroupId[] | null }): Promise<StoredRole>;
  updateRoleSalesGroups(user: AuthenticatedUser, name: string, groups: RevenueGroupId[] | null): Promise<StoredRole | undefined>;
  getRevenueConfiguration(entity: TargetEntity): Promise<RevenueConfiguration>;
  updateRevenueConfiguration(user: AuthenticatedUser, entity: TargetEntity, input: RevenueUpdate): Promise<RevenueConfiguration>;
  deleteRole(user: AuthenticatedUser, name: string): Promise<boolean>;
  updateUser(user: AuthenticatedUser, id: string, input: UserUpdate): Promise<StoredUser | undefined>;
  deleteUser(user: AuthenticatedUser, id: string): Promise<boolean>;
  listRoles(): Promise<StoredRole[]>;
  listUsers(user: AuthenticatedUser, page: Pick<RequestPage, 'limit' | 'offset'>): Promise<StoredUser[]>;
  updateUserRole(user: AuthenticatedUser, id: string, role: Role): Promise<StoredUser | undefined>;
  createUser(user: AuthenticatedUser): Promise<StoredUser>;
  create(user: AuthenticatedUser, input: CreateRequestInput): Promise<SupportRequest>;
  list(user: AuthenticatedUser, page: RequestPage): Promise<SupportRequest[]>;
  get(user: AuthenticatedUser, id: string): Promise<SupportRequest | undefined>;
  updateStatus(user: AuthenticatedUser, id: string, status: RequestStatus): Promise<SupportRequest | undefined>;
}

export type GraphFetch = (url: string, init: RequestInit) => Promise<Response>;

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
