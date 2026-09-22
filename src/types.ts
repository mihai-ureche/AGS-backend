export interface AppConfig {
  tenantId: string;
  databaseUrl: string;
  origins: string[];
  adminUserIds: string[];
  port: number;
  trustProxyHops: number;
}

export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  displayName: string | null;
  email: string | null;
  isAdmin: boolean;
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
